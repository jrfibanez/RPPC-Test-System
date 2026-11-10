// Phase 2 payroll (BR-15, BR-16, BR-17, BR-21, BR-24) — the computation is a system job.
import { describe, it, expect, beforeAll } from 'vitest';
import { freshDb, tx, makeUser } from './helpers';
import { buildWorld, tripReadyForGate, deliver, type World } from './world';
import { payroll } from '../packages/db/src/index';

const db = await freshDb();
let w: World; let act: string; let worker: Awaited<ReturnType<typeof makeUser>>; let periodId: string;
beforeAll(async () => {
  w = await buildWorld(db.app);
  act = (await db.app.query(`INSERT INTO production_activities (code, name, category) VALUES ('BNEP','BNEP fabrication','fabrication') RETURNING id`)).rows[0].id;
  await tx(db.app, async (t) => {
    await payroll.setActivityRate(t, w.owner, { activityId: act, rate: '17.50', effectiveFrom: '2026-01-01' });
    await payroll.setTripPayRate(t, w.owner, 'driver', '1000.00', '2026-01-01');
    await payroll.setTripPayRate(t, w.owner, 'helper', '600.00', '2026-01-01');
  });
  worker = await makeUser(db.app, ['WORKER']);
});

describe('production capture (BR-15)', () => {
  it('Security encodes, the Production Officer approves; the encoder cannot approve', async () => {
    const sup2 = await makeUser(db.app, ['SUPERVISOR'], { employee: true });
    const e = await tx(db.app, (t) => payroll.encodeProduction(t, sup2, { workDate: '2026-11-09', workerId: worker.employeeId!, activityId: act, qty: '20' }));
    await expect(tx(db.app, (t) => payroll.decideProduction(t, sup2, e.id, 'approve', null))).rejects.toThrow(/segregation of duties/);
    await tx(db.app, (t) => payroll.decideProduction(t, w.supervisor, e.id, 'approve', null));
    const e2 = await tx(db.app, (t) => payroll.encodeProduction(t, w.guard, { workDate: '2026-11-10', workerId: worker.employeeId!, activityId: act, qty: '30' }));
    await tx(db.app, (t) => payroll.decideProduction(t, w.supervisor, e2.id, 'approve', null));
  });
  it('workers cannot self-enter while production.allow_self_entry is off', async () => {
    await expect(tx(db.app, (t) => payroll.encodeProduction(t, worker, { workDate: '2026-11-10', workerId: worker.employeeId!, activityId: act, qty: '1' }))).rejects.toThrow(/switched off/);
  });
});

describe('weekly run (BR-16, BR-17)', () => {
  it('trip pay is flat per completed trip, dated by completion; the job freezes the total', async () => {
    const r = await tripReadyForGate(db.app, w, { requestedDate: '2026-11-09' });
    await deliver(db.app, w, r, { receivedAt: '2026-11-09T09:00:00+08:00' });   // completed Mon 9 Nov (Manila)
    await db.app.query(`UPDATE trips SET completed_at='2026-11-09T09:00:00+08:00' WHERE id=$1`, [r.trip.id]);
    const p = await tx(db.app, (t) => payroll.ensurePeriod(t, '2026-11-09'));
    expect([p.period_start, p.period_end]).toEqual(['2026-11-07', '2026-11-13']);   // Saturday–Friday
    periodId = p.id;
    const after = await tx(db.app, (t) => payroll.computePeriod(t, periodId));
    // production 20×17.50 + 30×17.50 = 875.00; driver 1,000; helper 600 → 2,475.00
    expect(after.total_snapshot).toBe('2475.00');
    expect(after.computed_by_job).toBe('weekly-payroll');
    expect((await db.app.query(`SELECT count(*)::int AS n FROM production_entries WHERE status='locked'`)).rows[0].n).toBe(2);
    const audit = (await db.app.query(`SELECT actor_id FROM audit_log WHERE action='payroll.compute'`)).rows[0];
    expect(audit.actor_id).toBeNull();                                // no person computed it
  });
  it('sign-offs: on the frozen total only, one person per step, never by a payee, all four before the Owner', async () => {
    await expect(tx(db.app, (t) => payroll.signOff(t, w.supervisor, periodId, 'production', '2000.00', null))).rejects.toThrow(/not the frozen total/);
    await tx(db.app, (t) => payroll.signOff(t, w.supervisor, periodId, 'production', '2475.00', null));
    await expect(tx(db.app, (t) => payroll.ownerApprovePeriod(t, w.owner, periodId))).rejects.toThrow(/BR-16: missing sign-off\(s\): security, hr, finance/);
    await tx(db.app, (t) => payroll.signOff(t, w.guard, periodId, 'security', '2475.00', null));
    await tx(db.app, (t) => payroll.signOff(t, w.hr, periodId, 'hr', '2475.00', null));
    // the driver is paid this week: a driver who was somehow also Finance could not sign
    const payee = await makeUser(db.app, ['FINANCE'], { employee: true });
    await db.app.query(`UPDATE users SET employee_id=$2 WHERE id=$1`, [payee.id, w.driver.employeeId]);
    await expect(tx(db.app, (t) => payroll.signOff(t, { ...payee, employeeId: w.driver.employeeId }, periodId, 'finance', '2475.00', null))).rejects.toThrow(/you are paid/);
    await tx(db.app, (t) => payroll.signOff(t, w.finance, periodId, 'finance', '2475.00', null));
    await expect(tx(db.app, (t) => payroll.ownerApprovePeriod(t, { ...w.owner, lastStepUpAt: new Date(Date.now() - 20 * 60_000) }, periodId))).rejects.toThrow(/step-up/);
    await expect(tx(db.app, (t) => payroll.ownerApprovePeriod(t, w.owner, periodId))).resolves.toMatchObject({ status: 'owner_approved' });
  });
  it('the Weekly Payroll Summary reproduces the Excel figures', async () => {
    const [s] = await tx(db.app, (t) => payroll.weeklySummary(t, w.owner));
    expect(s).toMatchObject({ total_weekly_payroll: '2475.00', no_of_manpower: 3, highest_salary: '1000.00', lowest_salary: '600.00' });
  });
  it('BR-24: HR pays, Security witnesses (different people); the period becomes paid and cannot be reopened', async () => {
    await expect(tx(db.app, (t) => payroll.recordPayout(t, w.hr, periodId, { employeeId: worker.employeeId!, witnessUserId: w.hr.id, acknowledged: true }))).rejects.toThrow(/witness must be Security/);
    await tx(db.app, (t) => payroll.recordPayout(t, w.hr, periodId, { employeeId: worker.employeeId!, witnessUserId: w.guard.id, acknowledged: true }));
    expect((await db.app.query(`SELECT amount FROM payroll_payouts WHERE employee_id=$1`, [worker.employeeId])).rows[0].amount).toBe('875.00');
    await expect(tx(db.app, (t) => payroll.reopenPeriod(t, w.owner, periodId, 'late correction'))).rejects.toThrow(/paid period cannot be reopened/);
  });
  it('workers see only their own earnings', async () => {
    const mine = await tx(db.app, (t) => payroll.myEarnings(t, worker));
    expect(mine.every((l: any) => l.employee_id === worker.employeeId)).toBe(true);
    expect(mine.length).toBe(2);
    await expect(tx(db.app, (t) => payroll.weeklySummary(t, worker))).rejects.toThrow(/missing payroll.read/);
  });
});

describe('reopen before paid (BR-16)', () => {
  it('voids the lines, unlocks entries, starts a new round; old sign-offs no longer count; no double pay', async () => {
    const e = await tx(db.app, (t) => payroll.encodeProduction(t, w.guard, { workDate: '2026-11-16', workerId: worker.employeeId!, activityId: act, qty: '10' }));
    await tx(db.app, (t) => payroll.decideProduction(t, w.supervisor, e.id, 'approve', null));
    const p = await tx(db.app, (t) => payroll.ensurePeriod(t, '2026-11-16'));
    await tx(db.app, (t) => payroll.computePeriod(t, p.id));
    await tx(db.app, (t) => payroll.signOff(t, w.supervisor, p.id, 'production', '175.00', null));
    const re = await tx(db.app, (t) => payroll.reopenPeriod(t, w.owner, p.id, 'missing entry'));
    expect([re.status, re.round]).toEqual(['open', 2]);
    const again = await tx(db.app, (t) => payroll.computePeriod(t, p.id));
    expect(again.total_snapshot).toBe('175.00');
    expect((await db.app.query(`SELECT count(*)::int AS n FROM payroll_lines WHERE period_id=$1 AND voided_at IS NULL`, [p.id])).rows[0].n).toBe(1);
    // the round-1 sign-off is on record but does not count for round 2
    await tx(db.app, (t) => payroll.signOff(t, w.supervisor, p.id, 'production', '175.00', null));
    expect((await db.app.query(`SELECT round FROM payroll_verifications WHERE period_id=$1 ORDER BY round`, [p.id])).rows.map((r) => r.round)).toEqual([1, 2]);
  });
});
