// §6 ledger timing, §10.5 / §10.8 postings, §14 opening balances, BR-14 reversals.
import { type Actor, P, requirePermission, assertPodComplete, type TripType, AppError, NotFound, RuleViolation, assertNotSelf } from '@rppc/core';
import { type Tx, one, maybe, many } from '../pool';
import { audit, type RequestCtx } from '../audit';

export type LocType = 'plant' | 'in_transit' | 'repair_area' | 'external';
export async function locId(tx: Tx, type: LocType): Promise<string> {
  return (await one<{ id: string }>(tx, `SELECT id FROM inventory_locations WHERE type=$1 AND site_id IS NULL ORDER BY name LIMIT 1`, [type])).id;
}
export async function siteLocId(tx: Tx, siteId: string): Promise<string> {
  const r = await maybe<{ id: string }>(tx, `SELECT id FROM inventory_locations WHERE site_id=$1`, [siteId]);
  if (!r) throw new NotFound('site has no inventory location');
  return r.id;
}

const MOVE = `INSERT INTO pallet_movements
  (occurred_at, pallet_type_id, condition, qty, from_location_id, to_location_id, ref_type, ref_id, trip_id, created_by, note, reversal_of)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`;
export interface Move {
  at: Date | string; palletTypeId: string; condition: string; qty: number; from: string; to: string;
  refType: string; refId: string | null; tripId?: string | null; note?: string | null; reversalOf?: number | null;
}
export async function move(tx: Tx, actor: Actor, m: Move): Promise<number> {
  const r = await one<{ id: number }>(tx, MOVE, [m.at, m.palletTypeId, m.condition, m.qty, m.from, m.to, m.refType, m.refId, m.tripId ?? null, actor.id, m.note ?? null, m.reversalOf ?? null]);
  return r.id;
}

interface LineRow { id: string; pallet_type_id: string; condition: string; qty_planned: number; qty_loaded: number | null; qty_delivered: number | null }

// Guard verifies the gate pass (trip → dispatched): pallets leave the plant but are NOT billable yet (BR-06, BR-14).
export async function postDispatch(tx: Tx, tripId: string, actor: Actor) {
  const plant = await locId(tx, 'plant'), transit = await locId(tx, 'in_transit');
  const rows = await many<LineRow>(tx, `SELECT * FROM trip_lines WHERE trip_id=$1 AND qty_loaded > 0`, [tripId]);
  for (const l of rows) {
    await move(tx, actor, { at: new Date(), palletTypeId: l.pallet_type_id, condition: l.condition, qty: l.qty_loaded!, from: plant, to: transit, refType: 'trip', refId: tripId, tripId });
  }
}

export async function loadPodEvidence(tx: Tx, tripId: string) {
  const photos = await many<{ stage: string; n: number; bad: number }>(tx,
    `SELECT stage, count(*)::int AS n, count(*) FILTER (WHERE lat IS NULL OR lng IS NULL OR taken_at_device IS NULL)::int AS bad
       FROM pod_photos WHERE trip_id=$1 GROUP BY stage`, [tripId]);
  const dr = await maybe<any>(tx, `SELECT receiver_name, receiver_signature_file_id FROM delivery_receipts WHERE trip_id=$1 AND status <> 'void'`, [tripId]);
  const ev = await many<{ event: string; at: Date }>(tx, `SELECT event, at FROM trip_events WHERE trip_id=$1`, [tripId]);
  const at = (e: string) => ev.find((x) => x.event === e)?.at;
  return {
    loadedPhotos: photos.find((p) => p.stage === 'loaded')?.n ?? 0,
    unloadedPhotos: photos.find((p) => p.stage === 'unloaded')?.n ?? 0,
    photosMissingGeoOrTime: photos.filter((p) => ['loaded', 'unloaded'].includes(p.stage)).reduce((s, p) => s + p.bad, 0),
    receiverName: dr?.receiver_name ?? undefined, hasSignature: !!dr?.receiver_signature_file_id,
    timeIn: at('arrived_site'), timeOut: at('departed_site'),
  };
}
async function podMinimums(tx: Tx) {
  const rows = await many<{ key: string; value: number }>(tx, `SELECT key, value FROM settings WHERE key IN ('pod.min_loaded_photos','pod.min_unloaded_photos')`);
  const get = (k: string) => Number(rows.find((r) => r.key === k)?.value ?? 1);
  return { loaded: get('pod.min_loaded_photos'), unloaded: get('pod.min_unloaded_photos') };
}

// Called in ONE transaction when the signed DR is received at the client site (BR-06, BR-14, BR-20).
// Rent starts at dr.received_at. Any shortfall (loaded − delivered) goes back in_transit → plant.
export async function postDelivery(tx: Tx, tripId: string, actor: Actor) {
  const trip = await one<any>(tx, 'SELECT * FROM trips WHERE id=$1', [tripId]);
  assertPodComplete(await loadPodEvidence(tx, tripId), trip.trip_type as TripType, await podMinimums(tx));
  const dr = await one<any>(tx, `SELECT * FROM delivery_receipts WHERE trip_id=$1 AND status <> 'void' FOR UPDATE`, [tripId]);
  if (!dr.received_at) throw new AppError('the DR has no signed-receipt time', 422);
  const siteLoc = await siteLocId(tx, dr.site_id), transit = await locId(tx, 'in_transit'), plant = await locId(tx, 'plant');
  const rows = await many<LineRow>(tx, `SELECT * FROM trip_lines WHERE trip_id=$1 FOR UPDATE`, [tripId]);
  for (const l of rows) {
    const delivered = l.qty_delivered ?? 0, short = (l.qty_loaded ?? 0) - delivered;
    if (short < 0) throw new AppError('delivered more than loaded', 422);
    if (delivered > 0) {   // the DB guard rejects it if THIS truck holds fewer pallets than delivered
      await move(tx, actor, { at: dr.received_at, palletTypeId: l.pallet_type_id, condition: l.condition, qty: delivered, from: transit, to: siteLoc, refType: 'delivery_receipt', refId: dr.id, tripId });
    }
    if (short > 0) {
      await move(tx, actor, { at: dr.received_at, palletTypeId: l.pallet_type_id, condition: l.condition, qty: short, from: transit, to: plant, refType: 'trip_shortfall', refId: tripId, tripId });
    }
  }
  await tx.query(`UPDATE delivery_receipts SET status='received' WHERE id=$1`, [dr.id]);
  await tx.query(`UPDATE trips SET completed_at=$2 WHERE id=$1 AND completed_at IS NULL`, [tripId, dr.received_at]);
  await audit(tx, actor, 'dr.received', 'delivery_receipt', dr.id, null, { lines: rows.length, received_at: dr.received_at });
}

// Client pickup (BR-26): the client's own truck leaves with the pallets, so there is no in_transit stage.
export async function postPickupHandover(tx: Tx, tripId: string, actor: Actor) {
  assertPodComplete(await loadPodEvidence(tx, tripId), 'pickup', await podMinimums(tx));
  const dr = await one<any>(tx, `SELECT * FROM delivery_receipts WHERE trip_id=$1 AND status <> 'void' FOR UPDATE`, [tripId]);
  const siteLoc = await siteLocId(tx, dr.site_id), plant = await locId(tx, 'plant');
  const rows = await many<LineRow>(tx, `SELECT * FROM trip_lines WHERE trip_id=$1 FOR UPDATE`, [tripId]);
  for (const l of rows) {
    if ((l.qty_loaded ?? 0) > 0) {
      await move(tx, actor, { at: dr.received_at, palletTypeId: l.pallet_type_id, condition: l.condition, qty: l.qty_loaded!, from: plant, to: siteLoc, refType: 'delivery_receipt', refId: dr.id, tripId });
    }
  }
  await tx.query(`UPDATE delivery_receipts SET status='received', delivered_at=received_at WHERE id=$1`, [dr.id]);
  await tx.query(`UPDATE trips SET completed_at=$2 WHERE id=$1 AND completed_at IS NULL`, [tripId, dr.received_at]);
  await audit(tx, actor, 'dr.received_pickup', 'delivery_receipt', dr.id, null, { lines: rows.length });
}

const CONDITION_ORDER = ['new', 'A', 'B', 'C', 'D', 'E', 'BER'];

/**
 * Rent stops at rr.received_at (BR-06). 'lost' lines are charged, not moved (§10.8).
 * Condition change on return: the site holds pallets in the condition they were delivered in, while the return records
 * the class found at the check. Where they differ, the pallets leave the site in their held condition and enter the
 * destination in the checked condition through the 'external' location, in the same transaction and with the same
 * timestamp and ref (ref_type 'return_reclass_out' / 'return_reclass_in'). The site balance — and therefore rent —
 * drops at exactly received_at either way.
 */
export async function postReturn(tx: Tx, rrId: string, actor: Actor) {
  const rr = await one<any>(tx, 'SELECT * FROM return_receipts WHERE id=$1 FOR UPDATE', [rrId]);
  const lines = await many<any>(tx, 'SELECT * FROM return_receipt_lines WHERE return_receipt_id=$1', [rrId]);
  if (!lines.length) throw new AppError('return receipt has no lines', 422);
  if (rr.return_mode === 'client_delivers' && rr.classified_at !== 'rppc_plant') throw new AppError('plant delivery is classified at the plant', 422);
  if (rr.return_mode === 'rppc_pickup' && !rr.trip_id) throw new AppError('an RPPC pickup return needs its trip', 422);
  const siteLoc = await siteLocId(tx, rr.site_id), ext = await locId(tx, 'external');
  const to = rr.return_mode === 'rppc_pickup' ? await locId(tx, 'in_transit') : await locId(tx, 'plant');
  const tripId = rr.return_mode === 'rppc_pickup' ? rr.trip_id : null;
  for (const l of lines.filter((x) => x.condition !== 'lost')) {
    let need: number = l.qty;
    const held = await many<{ condition: string; qty: number }>(tx,
      `SELECT condition, qty FROM v_pallet_balance WHERE location_id=$1 AND pallet_type_id=$2 AND qty > 0`, [siteLoc, l.pallet_type_id]);
    const same = held.find((h) => h.condition === l.condition);
    if (same) {
      const q = Math.min(need, same.qty);
      await move(tx, actor, { at: rr.received_at, palletTypeId: l.pallet_type_id, condition: l.condition, qty: q, from: siteLoc, to, refType: 'return_receipt', refId: rr.id, tripId });
      need -= q;
    }
    for (const h of held.filter((x) => x.condition !== l.condition).sort((a, b) => CONDITION_ORDER.indexOf(a.condition) - CONDITION_ORDER.indexOf(b.condition))) {
      if (need <= 0) break;
      const q = Math.min(need, h.qty);
      await move(tx, actor, { at: rr.received_at, palletTypeId: l.pallet_type_id, condition: h.condition, qty: q, from: siteLoc, to: ext, refType: 'return_reclass_out', refId: rr.id, note: `checked as ${l.condition}` });
      await move(tx, actor, { at: rr.received_at, palletTypeId: l.pallet_type_id, condition: l.condition, qty: q, from: ext, to, refType: 'return_reclass_in', refId: rr.id, tripId, note: `held as ${h.condition}` });
      need -= q;
    }
    if (need > 0) throw new RuleViolation('BR-14', `the site holds ${l.qty - need} pallets of this type, the return says ${l.qty}`);
  }
  await tx.query(`UPDATE return_receipts SET status='received' WHERE id=$1`, [rr.id]);
  await audit(tx, actor, 'rr.received', 'return_receipt', rr.id, null, { lines: lines.map((x) => ({ condition: x.condition, qty: x.qty })) });
}

// The pickup truck reaches the plant: unload exactly what that trip is carrying (from v_trip_in_transit) into the plant.
export async function postReturnArrival(tx: Tx, tripId: string, arrivedAt: Date, actor: Actor) {
  const transit = await locId(tx, 'in_transit'), plant = await locId(tx, 'plant');
  const rows = await many<{ pallet_type_id: string; condition: string; qty: number }>(tx, `SELECT pallet_type_id, condition, qty FROM v_trip_in_transit WHERE trip_id = $1`, [tripId]);
  for (const l of rows) {
    await move(tx, actor, { at: arrivedAt, palletTypeId: l.pallet_type_id, condition: l.condition, qty: l.qty, from: transit, to: plant, refType: 'trip_arrival', refId: tripId, tripId });
  }
  await tx.query(`UPDATE trips SET completed_at = COALESCE(completed_at, $2) WHERE id = $1`, [tripId, arrivedAt]);
}

/** §14 step 2: one 'opening_balance' movement from external to each site, dated the cut-over day; unknown mix booked as A. */
export async function importOpeningBalance(tx: Tx, actor: Actor, rows: Array<{ siteId: string; qty: number; condition?: string; palletTypeId?: string }>, cutoverAt: Date | string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.INV_APPROVE);
  const ext = await locId(tx, 'external');
  const pt = (await one<{ id: string }>(tx, `SELECT id FROM pallet_types WHERE code='ECR-1200x1000'`)).id;
  let total = 0;
  for (const r of rows) {
    if (r.qty <= 0) continue;
    const id = await move(tx, actor, { at: cutoverAt, palletTypeId: r.palletTypeId ?? pt, condition: r.condition ?? 'A', qty: r.qty, from: ext, to: await siteLocId(tx, r.siteId), refType: 'opening_balance', refId: r.siteId });
    total += r.qty;
    void id;
  }
  await audit(tx, actor, 'inventory.opening_balance', 'inventory', null, null, { sites: rows.length, total, cutover_at: cutoverAt }, ctx);
  return { total };
}
/** Plant opening stock / production in (external → plant). */
export async function receiveIntoPlant(tx: Tx, actor: Actor, qty: number, condition: string, refType: 'opening_balance' | 'production', at: Date | string = new Date(), ctx: RequestCtx = {}) {
  requirePermission(actor, P.INV_APPROVE);
  const pt = (await one<{ id: string }>(tx, `SELECT id FROM pallet_types WHERE code='ECR-1200x1000'`)).id;
  const id = await move(tx, actor, { at, palletTypeId: pt, condition, qty, from: await locId(tx, 'external'), to: await locId(tx, 'plant'), refType, refId: null });
  await audit(tx, actor, `inventory.${refType}`, 'pallet_movement', null, null, { movement_id: id, qty, condition }, ctx);
  return id;
}

/**
 * BR-14: corrections are reversal entries approved by OPS_MGR; if the requester is OPS_MGR, OWNER approves (§8.3).
 * The reversal mirrors the original (to ↔ from) at the original time, so billing history is corrected too.
 */
export async function reverseMovement(tx: Tx, actor: Actor, movementId: number, requestedBy: { id: string; roles: string[] }, reason: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.INV_APPROVE);
  assertNotSelf(actor, requestedBy.id);
  if (requestedBy.roles.includes('OPS_MGR') && !actor.roles.includes('OWNER')) throw new AppError('an adjustment requested by the Operations Manager is approved by the Owner', 403);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  const m = await maybe<any>(tx, 'SELECT * FROM pallet_movements WHERE id=$1', [movementId]);
  if (!m) throw new NotFound();
  const done = await maybe(tx, 'SELECT 1 FROM pallet_movements WHERE reversal_of=$1', [movementId]);
  if (done) throw new AppError('already reversed', 409);
  const id = await move(tx, actor, { at: m.occurred_at, palletTypeId: m.pallet_type_id, condition: m.condition, qty: m.qty, from: m.to_location_id, to: m.from_location_id,
    refType: 'reversal', refId: m.ref_id, tripId: m.trip_id, note: reason, reversalOf: movementId });
  await audit(tx, actor, 'inventory.reversal', 'pallet_movement', null, { movement_id: movementId }, { reversal_id: id, reason, requested_by: requestedBy.id }, ctx);
  return id;
}

export async function balances(tx: Tx, actor: Actor) {
  if (actor.roles.includes('CLIENT')) {
    requirePermission(actor, P.PORTAL_READ);
    return many(tx, `SELECT b.*, l.type, l.name, s.name AS site_name FROM v_pallet_balance b JOIN inventory_locations l ON l.id=b.location_id
                     JOIN client_sites s ON s.id = l.site_id WHERE s.client_id = $1 AND b.qty <> 0`, [actor.clientScope ?? null]);
  }
  requirePermission(actor, P.INV_READ);
  return many(tx, `SELECT b.*, l.type, l.name, s.name AS site_name, c.code AS client_code
                     FROM v_pallet_balance b JOIN inventory_locations l ON l.id=b.location_id
                     LEFT JOIN client_sites s ON s.id = l.site_id LEFT JOIN clients c ON c.id = s.client_id
                    WHERE b.qty <> 0 AND l.type <> 'external' ORDER BY l.type, s.name, b.condition`);
}
