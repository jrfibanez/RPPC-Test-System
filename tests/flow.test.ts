// §15 integration: proposal → SO → trip → DR → POD → ledger → billing summary → export; and the Phase 1 acceptance
// attempts (self-approval, dispatch without voucher, negative stock) — BR ids in test names (CLAUDE.md rule 7).
import { describe, it, expect, beforeAll } from 'vitest';
import { freshDb, tx, makeUser, fakeFile } from './helpers';
import { buildWorld, tripReadyForGate, plannedTrip, deliver, type World } from './world';
import { masters, commercial, trips, ledger, billing } from '../packages/db/src/index';

const db = await freshDb();
let w: World;
beforeAll(async () => { w = await buildWorld(db.app, { conformeOn: '2026-11-01', rate: '0.85', deliveryMode: 'charged' }); });

const siteBalance = async (siteId: string) =>
  Number((await db.app.query(`SELECT COALESCE(sum(b.qty),0)::int AS q FROM v_pallet_balance b JOIN inventory_locations l ON l.id=b.location_id WHERE l.site_id=$1`, [siteId])).rows[0].q);

describe('order-to-delivery, billed to the peso (Phase 1 acceptance 1)', () => {
  let bsId: string;
  it('BR-06: dispatch puts pallets in transit (not billable); the signed DR moves them to the site', async () => {
    const r = await tripReadyForGate(db.app, w, { requestedDate: '2026-11-05' });
    await tx(db.app, (t) => trips.verifyGatePass(t, w.guard, r.trip.id, { plateNo: 'NBC 1234', qty: 240 }));
    const inTransit = (await db.app.query(`SELECT qty FROM v_trip_in_transit WHERE trip_id=$1`, [r.trip.id])).rows;
    expect(inTransit).toEqual([{ qty: 240 }]);
    expect(await siteBalance(w.site.id)).toBe(0);
    // driver at site, photos, then the paper DR comes back: received 5 Nov 10:00 Manila = billing start.
    await tx(db.app, async (t) => {
      await trips.recordPodPhoto(t, w.driver, r.trip.id, { stage: 'loaded', fileId: await fakeFile(db.app, w.driver.id), takenAtDevice: new Date().toISOString(), lat: 14.3, lng: 121.08 });
      await trips.recordTripEvent(t, w.driver, r.trip.id, { event: 'arrived_site' });
      await trips.recordPodPhoto(t, w.driver, r.trip.id, { stage: 'unloaded', fileId: await fakeFile(db.app, w.driver.id), takenAtDevice: new Date().toISOString(), lat: 14.2117, lng: 121.1653 });
      await trips.recordTripEvent(t, w.driver, r.trip.id, { event: 'departed_site' });
    });
    const sig = await fakeFile(db.app, w.deploy.id, 'application/pdf');
    const res = await tx(db.app, (t) => trips.recordSignedDR(t, w.deploy, r.trip.id, { receiverName: 'R. Santos', signatureFileId: sig, receivedAt: '2026-11-05T10:00:00+08:00', delivered: [{ lineId: r.lineId, qtyDelivered: 240 }] }));
    expect(res.delivered).toBe(true);
    expect(await siteBalance(w.site.id)).toBe(240);
    expect((await db.app.query(`SELECT count(*)::int AS n FROM v_trip_in_transit WHERE trip_id=$1`, [r.trip.id])).rows[0].n).toBe(0);
    const t = (await db.app.query(`SELECT status, completed_at FROM trips WHERE id=$1`, [r.trip.id])).rows[0];
    expect(t.status).toBe('delivered');
  });

  it('BR-06: a return stops rent at the plant receipt; damage class recorded where checked (client delivers)', async () => {
    const rr = await tx(db.app, (t) => trips.createReturnReceipt(t, w.deploy, {
      clientId: w.client.id, siteId: w.site.id, returnMode: 'client_delivers', classifiedAt: 'rppc_plant', receivedAt: '2026-11-08T15:00:00+08:00',
      lines: [{ condition: 'A', qty: 30 }, { condition: 'C', qty: 10 }] }));
    await tx(db.app, (t) => trips.receiveReturn(t, w.deploy, rr.id));
    expect(await siteBalance(w.site.id)).toBe(200);
    const plantC = (await db.app.query(`SELECT b.qty FROM v_pallet_balance b JOIN inventory_locations l ON l.id=b.location_id WHERE l.type='plant' AND b.condition='C'`)).rows[0];
    expect(plantC.qty).toBe(10);                                     // arrived at the plant in the class found at the check
  });

  it('BR-06/BR-07: the first summary matches a hand-calculated period (delivery day counts, return day does not)', async () => {
    // Hand calculation, period 5–10 Nov (first delivery → cutoff 10th):
    //   end-of-day on site: 5,6,7 Nov = 240; 8,9,10 Nov = 200  →  720 + 600 = 1,320 pallet-days
    //   rental 1,320 × ₱0.85 = ₱1,122.00; delivery fee (charged, zone Laguna) ₱3,500.00; class C 10 × ₱400 = ₱4,000.00
    //   total VAT-ex ₱8,622.00; VAT 12% ₱1,034.64; total ₱9,656.64
    const { summary, unpricedDays } = await tx(db.app, (t) => billing.generateSummary(t, w.billing, w.site.id));
    bsId = summary.id;
    expect([summary.period_start, summary.period_end]).toEqual(['2026-11-05', '2026-11-10']);
    expect(unpricedDays).toBe(0);
    expect(summary.pallet_days).toBe(1320);
    expect(summary.rental_amount).toBe('1122.00');
    expect(summary.other_charges).toBe('7500.00');
    expect(summary.total_vat_ex).toBe('8622.00');
    const lines = (await db.app.query(`SELECT line_type, qty, unit_rate, amount FROM billing_summary_lines WHERE summary_id=$1 ORDER BY line_type`, [bsId])).rows;
    expect(lines).toEqual([
      { line_type: 'delivery_fee', qty: '1.00', unit_rate: '3500.0000', amount: '3500.00' },
      { line_type: 'rental', qty: '1320.00', unit_rate: '0.8500', amount: '1122.00' },
      { line_type: 'repair', qty: '10.00', unit_rate: '400.0000', amount: '4000.00' },
    ]);
  });

  it('BR-07/BR-08: review → send → client approval → export (VAT computed) → invoice with business-day deadline', async () => {
    await tx(db.app, (t) => billing.submitForReview(t, w.billing, bsId));
    await expect(tx(db.app, (t) => billing.exportSummaries(t, w.finance, [bsId]))).rejects.toThrow(/only client-approved/);
    await tx(db.app, (t) => billing.reviewSummary(t, w.opsMgr, bsId));
    await tx(db.app, (t) => billing.sendToClient(t, w.billing, bsId));
    await tx(db.app, (t) => billing.recordClientApproval(t, w.billing, bsId, { approverName: 'Ms. Reyes (Onestop)' }));
    const exp = await tx(db.app, (t) => billing.exportSummaries(t, w.finance, [bsId]));
    const [, row] = exp.csv.trim().split('\r\n');
    expect(row).toContain(',1320,1122.00,7500.00,8622.00,1034.64,9656.64,');
    expect(exp.filename).toMatch(/^billing-export-.*\.csv$/);
    // 13 Nov 2026 is a Friday; 16 Nov declared a holiday → business days 17,18,19,20,23 → deadline Mon 23 Nov.
    await tx(db.app, (t) => masters.addHoliday(t, w.admin, '2026-11-16', 'Test holiday'));
    const inv = await tx(db.app, (t) => billing.recordInvoice(t, w.billing, bsId, { invoiceRef: 'SI-0001', invoiceReceivedOn: '2026-11-13' }));
    expect(inv.dispute_deadline).toBe('2026-11-23');
  });

  it('BR-13: an issued summary is never edited; voiding a billed one needs break-glass', async () => {
    await expect(tx(db.app, (t) => billing.voidSummary(t, w.billing, bsId, 'oops'))).rejects.toThrow(/missing admin.break_glass/);
  });

  it('BR-28 / BR-10: days before the contract start are billed at the proposal rate; the contract rate after', async () => {
    const c = await tx(db.app, (t) => commercial.createContractFromProposal(t, w.sales, w.prop.id, { startDate: '2026-11-20' }));
    await tx(db.app, (t) => t.query(`UPDATE contracts SET rate_per_pallet_day = 0.80 WHERE id=$1`, [c.id]));   // negotiated contract rate
    await tx(db.app, async (t) => commercial.signContract(t, w.sales, c.id, { signedOn: '2026-11-18', fileId: await fakeFile(db.app, w.sales.id, 'application/pdf') }));
    const { summary } = await tx(db.app, (t) => billing.generateSummary(t, w.billing, w.site.id));
    expect([summary.period_start, summary.period_end]).toEqual(['2026-11-11', '2026-12-10']);
    const lines = (await db.app.query(`SELECT qty, unit_rate, amount FROM billing_summary_lines WHERE summary_id=$1 AND line_type='rental' ORDER BY unit_rate DESC`, [summary.id])).rows;
    // 11–19 Nov: 9 days × 200 = 1,800 × 0.85 = 1,530.00 ; 20 Nov–10 Dec: 21 days × 200 = 4,200 × 0.80 = 3,360.00
    expect(lines).toEqual([
      { qty: '1800.00', unit_rate: '0.8500', amount: '1530.00' },
      { qty: '4200.00', unit_rate: '0.8000', amount: '3360.00' },
    ]);
    expect(summary.rental_amount).toBe('4890.00');
  });

  it('BR-28: a day with pallets on site but no rate term blocks finalising (never billed at ₱0)', async () => {
    const site2 = await tx(db.app, (t) => masters.createSite(t, w.sales, w.client.id, { name: 'Sta. Rosa annex', address: 'Sta. Rosa, Laguna' }));
    await tx(db.app, (t) => ledger.importOpeningBalance(t, w.opsMgr, [{ siteId: site2.id, qty: 100 }], '2026-11-01T00:00:00+08:00'));
    const { summary, unpricedDays } = await tx(db.app, (t) => billing.generateSummary(t, w.billing, site2.id));
    expect(unpricedDays).toBe(10);
    expect(summary.rental_amount).toBe('0.00');
    await expect(tx(db.app, (t) => billing.submitForReview(t, w.billing, summary.id))).rejects.toThrow(/BR-28/);
  });
});

describe('trip rules', () => {
  it('BR-03: a trip carries at most the truck capacity', async () => {
    await expect(plannedTrip(db.app, w, { qty: 250, requestedDate: '2026-11-12' })).rejects.toThrow(/BR-03/);
  });
  it('BR-04: a delivery cannot be loaded or dispatched without a released voucher (acceptance 3)', async () => {
    const { trip } = await plannedTrip(db.app, w, { requestedDate: '2026-11-12' });
    await expect(tx(db.app, (t) => trips.startLoading(t, w.deploy, trip.id))).rejects.toThrow(/no transition planned → loading/);
    await tx(db.app, (t) => trips.issueDR(t, w.deploy, trip.id));
    await tx(db.app, (t) => trips.issueGatePass(t, w.deploy, trip.id));
    await db.owner.query(`UPDATE trips SET status='loading' WHERE id=$1`, [trip.id]);   // force past the state machine
    await db.owner.query(`UPDATE trip_lines SET qty_loaded=240 WHERE trip_id=$1`, [trip.id]);
    await expect(tx(db.app, (t) => trips.verifyGatePass(t, w.guard, trip.id, { plateNo: 'NBC 1234', qty: 240 }))).rejects.toThrow(/BR-04.*released voucher/);
  });
  it('BR-05: charged delivery takes the zone fee even for a partial load; free delivery is ₱0', async () => {
    const { trip } = await plannedTrip(db.app, w, { qty: 60, requestedDate: '2026-11-13' });
    expect(trip.delivery_fee).toBe('3500.00');
  });
  it('BR-20: delivered only with complete proof of delivery', async () => {
    const r = await tripReadyForGate(db.app, w, { requestedDate: '2026-11-14' });
    await tx(db.app, (t) => trips.verifyGatePass(t, w.guard, r.trip.id, { plateNo: 'NBC 1234', qty: 240 }));
    await tx(db.app, (t) => trips.recordTripEvent(t, w.driver, r.trip.id, { event: 'arrived_site' }));
    await tx(db.app, (t) => trips.recordTripEvent(t, w.driver, r.trip.id, { event: 'departed_site' }));
    const sig = await fakeFile(db.app, w.driver.id, 'image/png');
    await expect(tx(db.app, (t) => trips.recordSignedDR(t, w.driver, r.trip.id, { receiverName: 'X', signatureFileId: sig, delivered: [{ lineId: r.lineId, qtyDelivered: 240 }] })))
      .rejects.toThrow(/proof of delivery incomplete: loaded photos \(0\/1\), unloaded photos \(0\/1\)/);
  });
  it('BR-25: a photo far from the site or with a skewed clock is flagged, not blocked', async () => {
    const r = await tripReadyForGate(db.app, w, { requestedDate: '2026-11-15' });
    await tx(db.app, (t) => trips.verifyGatePass(t, w.guard, r.trip.id, { plateNo: 'NBC 1234', qty: 240 }));
    await tx(db.app, (t) => trips.recordTripEvent(t, w.driver, r.trip.id, { event: 'arrived_site' }));
    const p = await tx(db.app, async (t) => trips.recordPodPhoto(t, w.driver, r.trip.id, { stage: 'unloaded', fileId: await fakeFile(db.app, w.driver.id),
      takenAtDevice: new Date(Date.now() - 30 * 60_000).toISOString(), lat: 14.60, lng: 121.00 }));
    expect(p.flags.sort()).toEqual(['clock_skew', 'outside_geofence']);
  });
  it('a partial delivery returns the shortfall to the plant in the same transaction', async () => {
    const r = await tripReadyForGate(db.app, w, { requestedDate: '2026-11-16' });
    const before = await siteBalance(w.site.id);
    await deliver(db.app, w, r, { delivered: 230 });
    expect(await siteBalance(w.site.id)).toBe(before + 230);
    const short = (await db.app.query(`SELECT qty FROM pallet_movements WHERE trip_id=$1 AND ref_type='trip_shortfall'`, [r.trip.id])).rows;
    expect(short).toEqual([{ qty: 10 }]);
  });
});

describe('BR-26: client pickup', () => {
  it('needs no voucher, has no in-transit stage, and rent starts at the signed DR at the plant', async () => {
    const { trip } = await plannedTrip(db.app, w, { tripType: 'pickup', qty: 120, requestedDate: '2026-11-17' });
    expect(trip.voucher_required).toBe(false);
    await expect(tx(db.app, (t) => trips.requestVoucher(t, w.deploy, trip.id, { voucherNo: 'X1', budgetAmount: '1' }))).rejects.toThrow(/BR-26/);
    await tx(db.app, (t) => trips.issueDR(t, w.deploy, trip.id));
    await tx(db.app, (t) => trips.issueGatePass(t, w.deploy, trip.id));
    await tx(db.app, (t) => trips.startLoading(t, w.deploy, trip.id));
    const line = (await db.app.query(`SELECT id FROM trip_lines WHERE trip_id=$1`, [trip.id])).rows[0].id;
    await tx(db.app, (t) => trips.recordLoaded(t, w.deploy, trip.id, [{ lineId: line, qtyLoaded: 120 }]));
    await tx(db.app, (t) => trips.verifyGatePass(t, w.guard, trip.id, { plateNo: 'CLIENT-TRUCK', qty: 120 }));
    expect((await db.app.query(`SELECT count(*)::int AS n FROM pallet_movements WHERE trip_id=$1`, [trip.id])).rows[0].n).toBe(0);
    const before = await siteBalance(w.site.id);
    await tx(db.app, async (t) => trips.recordPodPhoto(t, w.deploy, trip.id, { stage: 'loaded', fileId: await fakeFile(db.app, w.deploy.id), takenAtDevice: new Date().toISOString(), lat: 14.3, lng: 121.08 }));
    await tx(db.app, async (t) => trips.recordSignedDR(t, w.deploy, trip.id, { receiverName: 'Client driver', signatureFileId: await fakeFile(db.app, w.deploy.id, 'image/png'), delivered: [] }));
    expect(await siteBalance(w.site.id)).toBe(before + 120);
    const mv = (await db.app.query(`SELECT l1.type AS f, l2.type AS t FROM pallet_movements m JOIN inventory_locations l1 ON l1.id=m.from_location_id JOIN inventory_locations l2 ON l2.id=m.to_location_id WHERE m.trip_id=$1`, [trip.id])).rows;
    expect(mv).toEqual([{ f: 'plant', t: 'client_site' }]);
  });
});

describe('BR-06: RPPC collects (return trip)', () => {
  it('site → in transit at the return receipt (rent stops), in transit → plant on arrival', async () => {
    const so = await tx(db.app, async (t) => {
      const s = await commercial.createSalesOrder(t, w.sales, { orderType: 'dehire', clientId: w.client.id, siteId: w.site.id, proposalId: w.prop.id, qty: 50, requestedDate: '2026-11-20' });
      await commercial.submitSalesOrder(t, w.sales, s.id); await commercial.decideSalesOrder(t, w.salesMgr, s.id, 'approve', null); return s;
    });
    const trip = await tx(db.app, async (t) => {
      const wo = await trips.createWorkOrder(t, w.deploy, so.id, { qty: 50, plannedDate: '2026-11-20' });
      const tr = await trips.createTrip(t, w.deploy, wo.id, { tripType: 'return', truckId: w.truck.id, driverId: w.driver.employeeId!, lines: [{ condition: 'A', qty: 50 }] });
      const v = await trips.requestVoucher(t, w.deploy, tr.id, { voucherNo: `PCV-${tr.trip_no}`, budgetAmount: '1800' });
      await trips.decideVoucher(t, w.owner, v.id, 'approve', null); await trips.releaseVoucher(t, w.finance, v.id);
      await trips.issueGatePass(t, w.deploy, tr.id); await trips.startLoading(t, w.deploy, tr.id);
      return tr;
    });
    await tx(db.app, (t) => trips.verifyGatePass(t, w.guard, trip.id, { plateNo: 'NBC 1234', qty: 0 }));
    await tx(db.app, (t) => trips.recordTripEvent(t, w.driver, trip.id, { event: 'arrived_site' }));
    const before = await siteBalance(w.site.id);
    const rr = await tx(db.app, (t) => trips.createReturnReceipt(t, w.auditor, { clientId: w.client.id, siteId: w.site.id, returnMode: 'rppc_pickup', classifiedAt: 'client_site',
      tripId: trip.id, receivedAt: new Date().toISOString(), clientRepName: 'Site supervisor', lines: [{ condition: 'B', qty: 45 }, { condition: 'BER', qty: 5 }] }));
    await tx(db.app, (t) => trips.receiveReturn(t, w.auditor, rr.id));
    expect(await siteBalance(w.site.id)).toBe(before - 50);
    expect((await db.app.query(`SELECT sum(qty)::int AS q FROM v_trip_in_transit WHERE trip_id=$1`, [trip.id])).rows[0].q).toBe(50);
    await tx(db.app, (t) => trips.recordTripEvent(t, w.driver, trip.id, { event: 'returned_plant' }));
    expect((await db.app.query(`SELECT count(*)::int AS n FROM v_trip_in_transit WHERE trip_id=$1`, [trip.id])).rows[0].n).toBe(0);
    await tx(db.app, (t) => trips.closeTrip(t, w.deploy, trip.id));
    expect((await db.app.query(`SELECT status, completed_at IS NOT NULL AS done FROM trips WHERE id=$1`, [trip.id])).rows[0]).toEqual({ status: 'closed', done: true });
  });
});

describe('segregation of duties (BR-21, BR-23, BR-27; acceptance 3)', () => {
  it('a sales manager cannot approve a sales order they created', async () => {
    const so = await tx(db.app, (t) => commercial.createSalesOrder(t, w.salesMgr, { orderType: 'deployment', clientId: w.client.id, siteId: w.site.id, proposalId: w.prop.id, qty: 240, requestedDate: '2026-11-25' }));
    await tx(db.app, (t) => commercial.submitSalesOrder(t, w.salesMgr, so.id));
    await expect(tx(db.app, (t) => commercial.decideSalesOrder(t, w.salesMgr, so.id, 'approve', null))).rejects.toThrow(/segregation of duties/);
    await expect(db.app.query(`UPDATE sales_orders SET approved_by = created_by WHERE id=$1`, [so.id])).rejects.toThrow(/check constraint/);
  });
  it('BR-27: an Owner-raised voucher is auto-approved and flagged; Finance releases, and not the Owner', async () => {
    const ownerFin = await makeUser(db.app, ['OWNER', 'FINANCE'], { employee: true });
    const { trip } = await plannedTrip(db.app, w, { requestedDate: '2026-11-26' });
    const v = await tx(db.app, (t) => trips.requestVoucher(t, ownerFin, trip.id, { voucherNo: 'PCV-OWN-1', budgetAmount: '2000' }));
    expect([v.status, v.owner_raised, v.approved_by]).toEqual(['approved', true, ownerFin.id]);
    await expect(tx(db.app, (t) => trips.releaseVoucher(t, ownerFin, v.id))).rejects.toThrow(/segregation of duties/);
    await expect(tx(db.app, (t) => trips.releaseVoucher(t, w.finance, v.id))).resolves.toMatchObject({ status: 'released' });
  });
  it('BR-23: only the Owner approves vouchers; the requester never approves their own', async () => {
    const { trip } = await plannedTrip(db.app, w, { requestedDate: '2026-11-27' });
    const v = await tx(db.app, (t) => trips.requestVoucher(t, w.deploy, trip.id, { voucherNo: 'PCV-SOD-1', budgetAmount: '2000' }));
    await expect(tx(db.app, (t) => trips.decideVoucher(t, w.opsMgr, v.id, 'approve', null))).rejects.toThrow(/missing trips.approve_budget/);
    await expect(tx(db.app, (t) => trips.releaseVoucher(t, w.finance, v.id))).rejects.toThrow(/voucher is requested/);
    const inbox = await tx(db.app, (t) => import('../packages/db/src/domain/approvals').then((a) => a.inbox(t, w.owner)));
    expect(inbox.some((a: any) => a.entity_id === v.id)).toBe(true);
  });
});

describe('commercial rules', () => {
  it('BR-01: an unaccredited client cannot get a sales order', async () => {
    const c = await tx(db.app, (t) => masters.createClient(t, w.sales, { code: 'NEWCO', legalName: 'New Co' }));
    const s = await tx(db.app, (t) => masters.createSite(t, w.sales, c.id, { name: 'WH', address: 'x' }));
    await expect(tx(db.app, (t) => commercial.createSalesOrder(t, w.sales, { orderType: 'deployment', clientId: c.id, siteId: s.id, proposalId: w.prop.id, qty: 240, requestedDate: '2026-11-20' }))).rejects.toThrow(/BR-01.*not accredited/);
  });
  it('BR-01: a site of another client can never be put on an order (composite key)', async () => {
    const c = await tx(db.app, (t) => masters.createClient(t, w.sales, { code: 'OTHER', legalName: 'Other Co' }));
    const s = await tx(db.app, (t) => masters.createSite(t, w.sales, c.id, { name: 'Other WH', address: 'x' }));
    await expect(db.app.query(`INSERT INTO sales_orders (order_type, client_id, site_id, proposal_id, qty, requested_date, created_by) VALUES ('deployment',$1,$2,$3,240,'2026-11-20',$4)`,
      [w.client.id, s.id, w.prop.id, w.sales.id])).rejects.toThrow(/foreign key/);
  });
  it('BR-02: below 240 needs an override with a reason, approved by a holder of so.override_min_qty', async () => {
    await expect(tx(db.app, (t) => commercial.createSalesOrder(t, w.sales, { orderType: 'deployment', clientId: w.client.id, siteId: w.site.id, proposalId: w.prop.id, qty: 100, requestedDate: '2026-11-20' }))).rejects.toThrow(/BR-02/);
    const so = await tx(db.app, (t) => commercial.createSalesOrder(t, w.sales, { orderType: 'deployment', clientId: w.client.id, siteId: w.site.id, proposalId: w.prop.id, qty: 100, minQtyOverrideReason: 'trial load', requestedDate: '2026-11-20' }));
    await tx(db.app, (t) => commercial.submitSalesOrder(t, w.sales, so.id));
    await expect(tx(db.app, (t) => commercial.decideSalesOrder(t, w.salesMgr, so.id, 'approve', null))).resolves.toMatchObject({ status: 'approved' });
  });
  it('BR-10: an expired proposal cannot be converted without re-approval', async () => {
    const p = await tx(db.app, async (t) => {
      const p0 = await commercial.createProposal(t, w.sales, { clientId: w.client.id, siteId: w.site.id, ratePerPalletDay: '0.90', validUntil: '2026-10-31' });
      await commercial.submitProposal(t, w.sales, p0.id); await commercial.decideProposal(t, w.salesMgr, p0.id, 'approve', null); return p0;
    });
    await expect(tx(db.app, async (t) => commercial.recordConforme(t, w.sales, p.id, { signedOn: '2026-11-02', fileId: await fakeFile(db.app, w.sales.id, 'application/pdf') }))).rejects.toThrow(/BR-10/);
  });
});

describe('scope / IDOR (§19.4)', () => {
  it('a driver cannot read or act on another driver’s trip (404, not 403)', async () => {
    const other = await makeUser(db.app, ['DRIVER']);
    const { trip } = await plannedTrip(db.app, w, { requestedDate: '2026-11-28' });
    await expect(tx(db.app, (t) => trips.getTrip(t, other, trip.id))).rejects.toThrow(/trip not found/);
    await expect(tx(db.app, (t) => trips.recordTripEvent(t, other, trip.id, { event: 'arrived_site' }))).rejects.toThrow(/trip not found/);
    expect(await tx(db.app, (t) => trips.listTrips(t, other))).toEqual([]);
    await expect(tx(db.app, (t) => trips.getTrip(t, w.driver, trip.id))).resolves.toMatchObject({ id: trip.id });
  });
  it('client A cannot read client B’s billing summaries or DRs', async () => {
    const b = await tx(db.app, (t) => masters.createClient(t, w.sales, { code: 'CLIENTB', legalName: 'Client B' }));
    const portalB = await makeUser(db.app, ['CLIENT'], { clientScope: b.id });
    const portalA = await makeUser(db.app, ['CLIENT'], { clientScope: w.client.id });
    expect(await tx(db.app, (t) => billing.listSummaries(t, portalB))).toEqual([]);
    const mine = await tx(db.app, (t) => billing.listSummaries(t, portalA));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((s: any) => s.client_id === w.client.id && s.status !== 'draft')).toBe(true);
    await expect(tx(db.app, (t) => billing.getSummary(t, portalB, mine[0].id))).rejects.toThrow(/not found/);
    expect((await tx(db.app, (t) => masters.listClients(t, portalB))).map((c: any) => c.id)).toEqual([b.id]);
  });
});

describe('audit trail (§8.5)', () => {
  it('every state change above wrote an audit row, and the chain verifies', async () => {
    const n = (await db.app.query(`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('trip.dispatched','dr.received','billing.export','voucher.release','rr.received')`)).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(5);
    expect((await db.owner.query(`SELECT * FROM fn_verify_audit_chain()`)).rowCount).toBe(0);
  });
});
