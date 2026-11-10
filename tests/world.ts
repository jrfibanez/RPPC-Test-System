// A small, realistic world: one accredited client with a site, a signed proposal conforme, a truck, a driver, a helper,
// and one user per office role. Built through the real services so every step is permission- and rule-checked.
import type { Pool } from '../packages/db/src/pool';
import { masters, commercial, trips, ledger } from '../packages/db/src/index';
import { tx, makeUser, fakeFile, actorOf } from './helpers';

export async function buildWorld(pool: Pool, opts: { conformeOn?: string; deliveryMode?: 'free' | 'charged'; rate?: string } = {}) {
  const [owner, admin, opsMgr, salesMgr, sales, deploy, finance, billing, hr, supervisor, auditor] = await Promise.all(
    ['OWNER', 'ADMIN_IT', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'FINANCE', 'BILLING', 'HR', 'SUPERVISOR', 'AUDITOR'].map((r) => makeUser(pool, [r], { employee: true })));
  const guard = await makeUser(pool, ['GUARD']);
  const driver = await makeUser(pool, ['DRIVER']);
  const helper = await makeUser(pool, ['HELPER']);

  const world = await tx(pool, async (t) => {
    const zone = await masters.createZone(t, admin, { name: 'Laguna', region: 'Luzon', kmFromPlant: 25 });
    await masters.setZoneRate(t, owner, zone.id, '3500.00', '2200.00', '2026-01-01');
    const truck = await masters.createTruck(t, admin, 'NBC 1234', 240);
    const client = await masters.createClient(t, sales, { code: 'ONESTOP', legalName: 'Onestop Warehousing Inc.' });
    const site = await masters.createSite(t, sales, client.id, { name: 'Calamba DC', address: 'Calamba, Laguna', region: 'Luzon', zoneId: zone.id, lat: 14.2117, lng: 121.1653 });
    const kyc = await fakeFile(pool, salesMgr.id, 'application/pdf');
    await masters.accreditClient(t, salesMgr, client.id, kyc);
    const prop = await commercial.createProposal(t, sales, { clientId: client.id, siteId: site.id, ratePerPalletDay: opts.rate ?? '0.85', deliveryMode: opts.deliveryMode ?? 'charged', validUntil: '2027-12-31' });
    await commercial.submitProposal(t, sales, prop.id);
    await commercial.decideProposal(t, salesMgr, prop.id, 'approve', null);
    await commercial.sendProposal(t, sales, prop.id);
    const conforme = await fakeFile(pool, sales.id, 'application/pdf');
    const { rateTerm } = await commercial.recordConforme(t, sales, prop.id, { signedOn: opts.conformeOn ?? '2026-11-01', fileId: conforme });
    return { zone, truck, client, site, prop, rateTerm };
  });
  // Plant opening stock (§14): enough new pallets to deliver.
  await tx(pool, (t) => ledger.receiveIntoPlant(t, opsMgr, 2000, 'new', 'opening_balance', '2026-10-01T00:00:00Z'));
  return { ...world, owner, admin, opsMgr, salesMgr, sales, deploy, finance, billing, hr, supervisor, auditor, guard, driver, helper };
}
export type World = Awaited<ReturnType<typeof buildWorld>>;

/** SO (approved) → WO → planned trip with one line. */
export async function plannedTrip(pool: Pool, w: World, opts: { qty?: number; requestedDate?: string; tripType?: 'delivery' | 'pickup' } = {}) {
  const qty = opts.qty ?? 240;
  const date = opts.requestedDate ?? '2026-11-05';
  return tx(pool, async (t) => {
    const so = await commercial.createSalesOrder(t, w.sales, { orderType: 'deployment', clientId: w.client.id, siteId: w.site.id, proposalId: w.prop.id, qty: Math.max(qty, 240), requestedDate: date });
    await commercial.submitSalesOrder(t, w.sales, so.id);
    await commercial.decideSalesOrder(t, w.salesMgr, so.id, 'approve', null);
    const wo = await trips.createWorkOrder(t, w.deploy, so.id, { qty, plannedDate: date });
    const trip = await trips.createTrip(t, w.deploy, wo.id, opts.tripType === 'pickup'
      ? { tripType: 'pickup', lines: [{ condition: 'new', qty }] }
      : { tripType: 'delivery', truckId: w.truck.id, driverId: w.driver.employeeId!, helperIds: [w.helper.employeeId!], lines: [{ condition: 'new', qty }] });
    return { so, wo, trip };
  });
}

/** SO → WO → trip with one line, voucher approved & released, DR + gate pass issued, loading recorded. Ready for the gate. */
export async function tripReadyForGate(pool: Pool, w: World, opts: { qty?: number; requestedDate?: string; tripType?: 'delivery' | 'pickup' } = {}) {
  const qty = opts.qty ?? 240;
  const { so, wo, trip } = await plannedTrip(pool, w, opts);
  const pickup = opts.tripType === 'pickup';
  return tx(pool, async (t) => {
    let voucher: any = null;
    if (!pickup) {
      voucher = await trips.requestVoucher(t, w.deploy, trip.id, { voucherNo: `PCV-${trip.trip_no}`, budgetAmount: '2200.00' });
      await trips.decideVoucher(t, w.owner, voucher.id, 'approve', null);
      await trips.releaseVoucher(t, w.finance, voucher.id);
    }
    const dr = await trips.issueDR(t, w.deploy, trip.id);
    const gp = await trips.issueGatePass(t, w.deploy, trip.id);
    await trips.startLoading(t, w.deploy, trip.id);
    const line = (await t.query('SELECT id FROM trip_lines WHERE trip_id=$1', [trip.id])).rows[0];
    await trips.recordLoaded(t, w.deploy, trip.id, [{ lineId: line.id, qtyLoaded: qty }]);
    return { so, wo, trip, voucher, dr, gp, lineId: line.id as string };
  });
}

/** Gate → site → photos → signed DR → time-out: a delivered trip. `receivedAt` (paper DR) lets tests pick the rent start. */
export async function deliver(pool: Pool, w: World, r: Awaited<ReturnType<typeof tripReadyForGate>>, opts: { qty?: number; delivered?: number; receivedAt?: string } = {}) {
  const qty = opts.qty ?? 240;
  await tx(pool, (t) => trips.verifyGatePass(t, w.guard, r.trip.id, { plateNo: 'NBC 1234', qty }));
  await tx(pool, async (t) => {
    const now = new Date().toISOString();
    await trips.recordPodPhoto(t, w.driver, r.trip.id, { stage: 'loaded', fileId: await fakeFile(pool, w.driver.id), takenAtDevice: now, lat: 14.33, lng: 121.08 });
    await trips.recordTripEvent(t, w.driver, r.trip.id, { event: 'arrived_site', lat: 14.2117, lng: 121.1653 });
    await trips.recordPodPhoto(t, w.driver, r.trip.id, { stage: 'unloaded', fileId: await fakeFile(pool, w.driver.id), takenAtDevice: now, lat: 14.2118, lng: 121.1654 });
  });
  const sig = await fakeFile(pool, w.driver.id, 'image/png');
  if (opts.receivedAt) {
    // Paper DR path: the Deployment Officer enters the received time later (§5 M5).
    await tx(pool, (t) => trips.recordTripEvent(t, w.driver, r.trip.id, { event: 'departed_site' }));
    await tx(pool, (t) => trips.recordSignedDR(t, w.deploy, r.trip.id, { receiverName: 'J. dela Cruz', signatureFileId: sig, receivedAt: opts.receivedAt, delivered: [{ lineId: r.lineId, qtyDelivered: opts.delivered ?? qty }] }));
  } else {
    await tx(pool, (t) => trips.recordSignedDR(t, w.driver, r.trip.id, { receiverName: 'J. dela Cruz', signatureFileId: sig, delivered: [{ lineId: r.lineId, qtyDelivered: opts.delivered ?? qty }] }));
    await tx(pool, (t) => trips.recordTripEvent(t, w.driver, r.trip.id, { event: 'departed_site' }));
  }
}
export { actorOf };
