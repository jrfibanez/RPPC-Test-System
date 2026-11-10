// §15 DB layer and §19.4 CI checks that are pure database behaviour.
import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { freshDb, makeUser, fakeFile, tx } from './helpers';
import { buildWorld, tripReadyForGate, plannedTrip, deliver, type World } from './world';
import { trips, billing, payroll, ledger } from '../packages/db/src/index';
import { migrate } from '../packages/db/src/migrate';

const db = await freshDb();
let w: World;
beforeAll(async () => { w = await buildWorld(db.app); });

describe('document numbering (S0.5)', () => {
  it('next_doc_no is gap-free under 100 parallel inserts', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => db.app.query(`SELECT next_doc_no('TESTDOC','TD') AS n`)));
    const nums = results.map((r) => Number(r.rows[0].n.split('-')[2])).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(results[0].rows[0].n).toMatch(/^TD-\d{4}-\d{6}$/);
  });
  it('a rolled-back document does not consume a number', async () => {
    const c = await db.app.connect();
    await c.query('BEGIN'); await c.query(`SELECT next_doc_no('TESTDOC2','T2')`); await c.query('ROLLBACK'); c.release();
    const r = await db.app.query(`SELECT next_doc_no('TESTDOC2','T2') AS n`);
    expect(r.rows[0].n).toMatch(/-000001$/);
  });
});

describe('append-only tables (BR-14, §8.5)', () => {
  it('audit_log rows cannot be updated or deleted, even by the owner role', async () => {
    await expect(db.owner.query(`UPDATE audit_log SET action='x'`)).rejects.toThrow(/append-only/);
    await expect(db.owner.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
  it('pallet_movements rows cannot be updated or deleted', async () => {
    await expect(db.owner.query(`UPDATE pallet_movements SET qty = qty + 1`)).rejects.toThrow(/append-only/);
    await expect(db.owner.query(`DELETE FROM pallet_movements`)).rejects.toThrow(/append-only/);
  });
  it('app_user has no UPDATE privilege on the append-only tables at all', async () => {
    await expect(db.app.query(`UPDATE audit_log SET action='x' WHERE false`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`UPDATE pallet_movements SET qty=1 WHERE false`)).rejects.toThrow(/permission denied/);
  });
  it('app_user cannot run DDL or TRUNCATE (least privilege, §8.2)', async () => {
    await expect(db.app.query(`TRUNCATE trips`)).rejects.toThrow(/permission denied|must be owner/);
    await expect(db.app.query(`DROP TABLE trips`)).rejects.toThrow(/must be owner|permission denied/);
    await expect(db.app.query(`DELETE FROM delivery_receipts`)).rejects.toThrow(/permission denied/);
  });
});

describe('audit hash chain (§7.1)', () => {
  it('verifies with no broken row, also when the verifier runs under a different session time zone', async () => {
    const c = await db.owner.connect();
    try {
      for (const tz of ['UTC', 'Asia/Manila', 'America/Los_Angeles']) {
        await c.query(`SET TIME ZONE '${tz}'`);
        const r = await c.query('SELECT * FROM fn_verify_audit_chain()');
        expect(r.rowCount, `broken under ${tz}`).toBe(0);
      }
      const n = await c.query('SELECT count(*)::int AS n FROM audit_log');
      expect(n.rows[0].n).toBeGreaterThan(10);
    } finally { c.release(); }
  });
  it('stays intact under concurrent writers (regression: id drawn before the lock, fixed in 0014)', async () => {
    const scratch = await freshDb();
    for (let round = 0; round < 5; round += 1) {
      await Promise.all(Array.from({ length: 40 }, (_, i) => scratch.app.query(`BEGIN; INSERT INTO audit_log (action) VALUES ('c${round}-${i}'); SELECT pg_sleep(random() / 200); COMMIT;`)));
    }
    expect((await scratch.owner.query('SELECT * FROM fn_verify_audit_chain()')).rowCount).toBe(0);
  });
  it('detects tampering (a row altered with triggers bypassed)', async () => {
    const scratch = await freshDb();
    const c = await scratch.owner.connect();
    try {
      await c.query(`INSERT INTO audit_log (action) VALUES ('a'), ('b'), ('c')`);
      await c.query(`SET session_replication_role = replica`);     // superuser-only: simulates direct tampering
      await c.query(`UPDATE audit_log SET action='B!' WHERE action='b'`);
      await c.query(`SET session_replication_role = origin`);
      const r = await c.query('SELECT * FROM fn_verify_audit_chain()');
      expect(r.rowCount).toBe(1);
    } finally { c.release(); }
  });
});

describe('migrations (CLAUDE.md rule 2)', () => {
  it('re-running is a no-op, and an edited applied migration is refused', async () => {
    expect(await migrate(db.url)).toEqual([]);
    await db.owner.query(`UPDATE schema_migrations SET sha256='tampered' WHERE name='0001_foundation.sql'`);
    await expect(migrate(db.url)).rejects.toThrow(/edited after it was applied/);
  });
});

describe('overlap guards (§19.4)', () => {
  it('two active rate terms for the same site and day are refused (BR-28)', async () => {
    await expect(db.app.query(`INSERT INTO site_rate_terms (site_id, source_type, proposal_id, rate_per_pallet_day, effective_from, created_by)
                               VALUES ($1,'proposal',$2,0.90,'2026-12-01',$3)`, [w.site.id, w.prop.id, w.sales.id])).rejects.toThrow(/conflicting key value violates exclusion constraint/);
  });
  it('two live billing summaries covering the same dates are refused; a void one frees its dates', async () => {
    const ins = () => db.app.query(`INSERT INTO billing_summaries (client_id, site_id, period_start, period_end, created_by) VALUES ($1,$2,'2027-03-11','2027-04-10',$3) RETURNING id`, [w.client.id, w.site.id, w.billing.id]);
    const a = await ins();
    await expect(ins()).rejects.toThrow(/exclusion constraint/);
    await tx(db.app, (t) => billing.voidSummary(t, w.billing, a.rows[0].id, 'wrong period'));
    await expect(ins()).resolves.toBeTruthy();
  });
  it('two payroll periods covering the same dates are refused; a period must be Saturday–Friday', async () => {
    await db.app.query(`INSERT INTO payroll_periods (period_start, period_end, yr) VALUES ('2027-01-02','2027-01-08',2027)`);
    await expect(db.app.query(`INSERT INTO payroll_periods (period_start, period_end, yr) VALUES ('2027-01-02','2027-01-08',2027)`)).rejects.toThrow();
    await expect(db.app.query(`INSERT INTO payroll_periods (period_start, period_end, yr) VALUES ('2027-01-04','2027-01-10',2027)`)).rejects.toThrow(/check constraint/);
  });
  it('overlapping activity rates and trip-pay rates are refused', async () => {
    const act = (await db.app.query(`INSERT INTO production_activities (code, name, category) VALUES ('T-OVL','Overlap test','other') RETURNING id`)).rows[0].id;
    await db.app.query(`INSERT INTO activity_rates (activity_id, rate, effective_from, set_by) VALUES ($1, 10, '2026-01-01', $2)`, [act, w.owner.id]);
    await expect(db.app.query(`INSERT INTO activity_rates (activity_id, rate, effective_from, set_by) VALUES ($1, 11, '2026-06-01', $2)`, [act, w.owner.id])).rejects.toThrow(/exclusion/);
    await db.app.query(`INSERT INTO trip_pay_rates (crew_role, amount_per_trip, effective_from, set_by) VALUES ('driver', 1000, '2026-01-01', $1)`, [w.owner.id]);
    await expect(db.app.query(`INSERT INTO trip_pay_rates (crew_role, amount_per_trip, effective_from, set_by) VALUES ('driver', 1100, '2026-05-01', $1)`, [w.owner.id])).rejects.toThrow(/exclusion/);
  });
});

describe('reissue after void (§19.4)', () => {
  it('a voided DR and gate pass can be re-created; a live duplicate is still refused', async () => {
    const r = await tripReadyForGate(db.app, w, { requestedDate: '2026-11-06' });
    await expect(tx(db.app, (t) => trips.issueDR(t, w.deploy, r.trip.id))).rejects.toThrow(/dr_one_live_per_trip/);
    await expect(tx(db.app, (t) => trips.issueGatePass(t, w.deploy, r.trip.id))).rejects.toThrow(/gp_one_live_per_trip/);
    await tx(db.app, (t) => trips.voidDR(t, w.opsMgr, r.dr.id, 'misprint'));
    const dr2 = await tx(db.app, (t) => trips.issueDR(t, w.deploy, r.trip.id));
    expect(dr2.dr_no).not.toBe(r.dr.dr_no);                          // numbers are never reused (BR-13)
    await db.app.query(`UPDATE gate_passes SET status='void' WHERE id=$1`, [r.gp.id]);
    await expect(tx(db.app, (t) => trips.issueGatePass(t, w.deploy, r.trip.id))).resolves.toBeTruthy();
  });
  it('a voided voucher can be re-issued for the same trip; a second live one is refused', async () => {
    const { trip: t1 } = await plannedTrip(db.app, w, { requestedDate: '2026-11-07' });
    const v1 = await tx(db.app, (t) => trips.requestVoucher(t, w.deploy, t1.id, { voucherNo: 'PCV-R1', budgetAmount: '1500' }));
    await expect(tx(db.app, (t) => trips.requestVoucher(t, w.deploy, t1.id, { voucherNo: 'PCV-R2', budgetAmount: '1500' }))).rejects.toThrow(/voucher_one_live_per_trip/);
    await tx(db.app, (t) => trips.voidVoucher(t, w.deploy, v1.id, 'wrong amount'));
    await expect(tx(db.app, (t) => trips.requestVoucher(t, w.deploy, t1.id, { voucherNo: 'PCV-R2', budgetAmount: '1600' }))).resolves.toBeTruthy();
  });
  it('a rejected production entry can be re-entered; a live duplicate is refused', async () => {
    const act = (await db.app.query(`INSERT INTO production_activities (code, name, category) VALUES ('BNEP','BNEP fabrication','fabrication') RETURNING id`)).rows[0].id;
    await tx(db.app, (t) => payroll.setActivityRate(t, w.owner, { activityId: act, rate: '17.50', effectiveFrom: '2026-01-01' }));
    const worker = await makeUser(db.app, ['WORKER']);
    const e1 = await tx(db.app, (t) => payroll.encodeProduction(t, w.guard, { workDate: '2026-11-09', workerId: worker.employeeId!, activityId: act, qty: '40' }));
    await expect(tx(db.app, (t) => payroll.encodeProduction(t, w.guard, { workDate: '2026-11-09', workerId: worker.employeeId!, activityId: act, qty: '41' }))).rejects.toThrow(/production_entry_uq/);
    await tx(db.app, (t) => payroll.decideProduction(t, w.supervisor, e1.id, 'reject', 'count does not match sheet'));
    const e2 = await tx(db.app, (t) => payroll.encodeProduction(t, w.guard, { workDate: '2026-11-09', workerId: worker.employeeId!, activityId: act, qty: '38' }));
    expect(e2.amount).toBe('665.00');                                 // 38 × 17.50, rate snapshotted (BR-15)
  });
  it('a voided payroll line can be paid again; a live duplicate is refused', async () => {
    const emp = (await db.app.query(`INSERT INTO employees (employee_no, full_name) VALUES ('PL-1','Payline Test') RETURNING id`)).rows[0].id;
    const per = (await db.app.query(`INSERT INTO payroll_periods (period_start, period_end, yr) VALUES ('2027-02-06','2027-02-12',2027) RETURNING id`)).rows[0].id;
    const ref = '00000000-0000-0000-0000-0000000000aa';
    const ins = () => db.app.query(`INSERT INTO payroll_lines (period_id, employee_id, source, ref_id, description, amount) VALUES ($1,$2,'trip',$3,'x',1000) RETURNING id`, [per, emp, ref]);
    const l1 = await ins();
    await expect(ins()).rejects.toThrow(/payroll_line_once/);
    await db.app.query(`UPDATE payroll_lines SET voided_at=now(), void_reason='wrong week' WHERE id=$1`, [l1.rows[0].id]);
    await expect(ins()).resolves.toBeTruthy();
  });
});

describe('ledger guards (BR-14)', () => {
  it('negative stock is blocked at the source location', async () => {
    const plant = await tx(db.app, (t) => ledger.locId(t, 'plant'));
    const ext = await tx(db.app, (t) => ledger.locId(t, 'external'));
    const pt = (await db.app.query(`SELECT id FROM pallet_types LIMIT 1`)).rows[0].id;
    await expect(db.app.query(`INSERT INTO pallet_movements (occurred_at, pallet_type_id, condition, qty, from_location_id, to_location_id, ref_type, created_by)
                               VALUES (now(), $1, 'E', 5, $2, $3, 'test', $4)`, [pt, plant, ext, w.opsMgr.id])).rejects.toThrow(/Insufficient stock/);
  });
  it('movements into in_transit must carry a trip_id', async () => {
    const plant = await tx(db.app, (t) => ledger.locId(t, 'plant'));
    const transit = await tx(db.app, (t) => ledger.locId(t, 'in_transit'));
    const pt = (await db.app.query(`SELECT id FROM pallet_types LIMIT 1`)).rows[0].id;
    await expect(db.app.query(`INSERT INTO pallet_movements (occurred_at, pallet_type_id, condition, qty, from_location_id, to_location_id, ref_type, created_by)
                               VALUES (now(), $1, 'new', 1, $2, $3, 'test', $4)`, [pt, plant, transit, w.opsMgr.id])).rejects.toThrow(/must carry a trip_id/);
  });
});

describe('row-level security (§7.10)', () => {
  it('app_user sees all rows; app_client only its own client, and nothing when app.client_id is unset', async () => {
    const r = await tripReadyForGate(db.app, w, { requestedDate: '2026-11-08' });
    await deliver(db.app, w, r);
    const all = await db.app.query(`SELECT count(*)::int AS n FROM delivery_receipts`);
    expect(all.rows[0].n).toBeGreaterThan(0);
    const c = await db.app.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE app_client');
      expect((await c.query(`SELECT count(*)::int AS n FROM delivery_receipts`)).rows[0].n).toBe(0);    // fail closed
      await c.query(`SELECT set_config('app.client_id', $1, true)`, [w.client.id]);
      const own = (await c.query(`SELECT count(*)::int AS n FROM delivery_receipts`)).rows[0].n;
      expect(own).toBe(all.rows[0].n - (await db.app.query(`SELECT count(*)::int AS n FROM delivery_receipts WHERE status='void'`)).rows[0].n);
      await c.query(`SELECT set_config('app.client_id', $1, true)`, ['00000000-0000-0000-0000-000000000001']);
      expect((await c.query(`SELECT count(*)::int AS n FROM delivery_receipts`)).rows[0].n).toBe(0);
      await expect(c.query(`UPDATE delivery_receipts SET receiver_name='x'`)).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });
});
void pg; void fakeFile;
