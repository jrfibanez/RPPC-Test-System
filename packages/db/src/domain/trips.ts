// §5 M4/M5: work orders, trips (+ lines), vouchers (BR-23, BR-27), DR, gate pass, POD, signed receipt, returns.
import { z } from 'zod';
import {
  type Actor, P, requirePermission, assertNotSelf, can, AppError, NotFound, Forbidden, RuleViolation,
  transitionPermission, assertCanDispatch, type TripStatus, type TripType, photoFlags,
} from '@rppc/core';
import { type Tx, one, maybe, many } from '../pool';
import { audit, type RequestCtx } from '../audit';
import { requestApproval, closeApproval, registerDecisionHandler } from './approvals';
import { postDispatch, postDelivery, postPickupHandover, postReturn, postReturnArrival } from './ledger';

async function lockTrip(tx: Tx, id: string) {
  const t = await maybe<any>(tx, 'SELECT * FROM trips WHERE id=$1 FOR UPDATE', [id]);
  if (!t) throw new NotFound('trip not found');
  return t;
}

/** Scope (§8.2): a driver/helper can only touch trips they are assigned to. Office roles are not scoped here. */
export async function assertTripAssignedTo(tx: Tx, actor: Actor, tripId: string) {
  if (!actor.roles.some((r) => r === 'DRIVER' || r === 'HELPER')) return;
  const ok = await maybe(tx,
    `SELECT 1 FROM trips t WHERE t.id=$1 AND (t.driver_id = $2 OR EXISTS (SELECT 1 FROM trip_helpers h WHERE h.trip_id=t.id AND h.employee_id=$2))`,
    [tripId, actor.employeeId ?? null]);
  if (!ok) throw new NotFound('trip not found');   // 404, not 403: do not reveal that someone else's trip exists (IDOR)
}

/** Move a trip along its state machine; the transition table decides which permission is needed (§10.4). */
async function transition(tx: Tx, actor: Actor, trip: any, to: TripStatus, opts: { permOverride?: boolean } = {}, ctx: RequestCtx = {}) {
  const perm = transitionPermission(trip.trip_type as TripType, trip.status, to);
  if (!opts.permOverride) requirePermission(actor, perm);
  const after = await one(tx, 'UPDATE trips SET status=$2 WHERE id=$1 RETURNING *', [trip.id, to]);
  await audit(tx, actor, `trip.${to}`, 'trip', trip.id, { status: trip.status }, { status: to }, ctx);
  return after;
}

// ---- work orders ---------------------------------------------------------------------------------------------
export async function createWorkOrder(tx: Tx, actor: Actor, soId: string, input: { qty: number; plannedDate: string }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.TRIP_WRITE);
  const so = await maybe<any>(tx, 'SELECT * FROM sales_orders WHERE id=$1 FOR UPDATE', [soId]);
  if (!so) throw new NotFound('sales order not found');
  if (!['approved', 'scheduled', 'in_progress'].includes(so.status)) throw new AppError(`sales order is ${so.status}`, 409);
  const planned = await one<{ q: number }>(tx, `SELECT COALESCE(sum(qty),0)::int AS q FROM work_orders WHERE sales_order_id=$1 AND status <> 'cancelled'`, [soId]);
  if (planned.q + input.qty > so.qty) throw new AppError(`work orders would exceed the order (${planned.q}+${input.qty} > ${so.qty})`, 422);
  const wo = await one(tx, 'INSERT INTO work_orders (sales_order_id, qty, planned_date, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [soId, input.qty, input.plannedDate, actor.id]);
  if (so.status === 'approved') await tx.query(`UPDATE sales_orders SET status='scheduled' WHERE id=$1`, [soId]);
  await audit(tx, actor, 'wo.create', 'work_order', wo.id, null, wo, ctx);
  return wo;
}
export const RESCHEDULE_REASONS = ['production_delay', 'truck_unavailable', 'client_request'] as const;
export async function rescheduleWorkOrder(tx: Tx, actor: Actor, woId: string, plannedDate: string, reason: (typeof RESCHEDULE_REASONS)[number], note: string | null, ctx: RequestCtx = {}) {
  requirePermission(actor, P.TRIP_WRITE);
  if (!RESCHEDULE_REASONS.includes(reason)) throw new AppError('reason must be production_delay, truck_unavailable or client_request', 422);
  const wo = await one<any>(tx, 'SELECT * FROM work_orders WHERE id=$1 FOR UPDATE', [woId]);
  const entry = { from: wo.planned_date, to: plannedDate, reason, note, by: actor.id, at: new Date().toISOString() };
  const after = await one(tx, `UPDATE work_orders SET planned_date=$2, reschedule_log = reschedule_log || $3::jsonb WHERE id=$1 RETURNING *`, [woId, plannedDate, JSON.stringify([entry])]);
  await tx.query(`UPDATE trips SET planned_date=$2 WHERE work_order_id=$1 AND status IN ('planned','budget_approved','budget_released')`, [woId, plannedDate]);
  await audit(tx, actor, 'wo.reschedule', 'work_order', woId, { planned_date: wo.planned_date }, entry, ctx);
  return after;
}

// ---- trips ---------------------------------------------------------------------------------------------------
export const TripInput = z.object({
  tripType: z.enum(['delivery', 'pickup', 'return', 'internal']).default('delivery'),
  truckId: z.string().uuid().optional().nullable(), driverId: z.string().uuid().optional().nullable(),
  helperIds: z.array(z.string().uuid()).default([]), plannedDate: z.string().optional(),
  lines: z.array(z.object({ palletTypeId: z.string().uuid().optional(), condition: z.enum(['new', 'A', 'B', 'C', 'D', 'E', 'BER']).default('new'), qty: z.number().int().positive() })).min(1),
});
export async function createTrip(tx: Tx, actor: Actor, woId: string, input: z.input<typeof TripInput>, ctx: RequestCtx = {}) {
  requirePermission(actor, P.TRIP_WRITE);
  const t = TripInput.parse(input);
  const wo = await maybe<any>(tx, 'SELECT * FROM work_orders WHERE id=$1', [woId]);
  if (!wo) throw new NotFound('work order not found');
  const so = await one<any>(tx, 'SELECT * FROM sales_orders WHERE id=$1', [wo.sales_order_id]);
  const total = t.lines.reduce((s, l) => s + l.qty, 0);
  const truck = t.truckId ? await one<any>(tx, 'SELECT * FROM trucks WHERE id=$1', [t.truckId]) : null;
  if (t.tripType !== 'pickup' && !truck) throw new AppError('an RPPC trip needs a truck', 422);
  if (truck && truck.status !== 'active') throw new AppError(`truck ${truck.plate_no} is ${truck.status}`, 422);
  const capacity = truck?.capacity_pallets ?? 240;
  if (total > capacity) throw new RuleViolation('BR-03', `one trip carries at most ${capacity} pallets (planned ${total})`);
  // BR-05: delivery free or charged per proposal/contract; charged = zone fee per trip, even for partial loads.
  const terms = so.contract_id ? await one<any>(tx, 'SELECT delivery_mode FROM contracts WHERE id=$1', [so.contract_id])
    : so.proposal_id ? await one<any>(tx, 'SELECT delivery_mode FROM proposals WHERE id=$1', [so.proposal_id]) : { delivery_mode: 'free' };
  const site = await one<any>(tx, 'SELECT * FROM client_sites WHERE id=$1', [so.site_id]);
  const plannedDate = t.plannedDate ?? wo.planned_date;
  let fee = '0.00';
  const mode = t.tripType === 'pickup' ? 'free' : terms.delivery_mode;   // a client pickup is not an RPPC delivery (BR-26)
  if (mode === 'charged' && t.tripType === 'delivery') {
    const zr = site.zone_id ? await maybe<any>(tx, `SELECT fee_per_trip FROM zone_rates WHERE zone_id=$1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)
                                                     ORDER BY effective_from DESC LIMIT 1`, [site.zone_id, plannedDate]) : null;
    if (!zr) throw new RuleViolation('BR-05', `delivery is charged but site "${site.name}" has no zone rate in force on ${plannedDate}`);
    fee = zr.fee_per_trip;
  }
  const pt = (await one<{ id: string }>(tx, `SELECT id FROM pallet_types WHERE code='ECR-1200x1000'`)).id;
  const trip = await one(tx,
    `INSERT INTO trips (work_order_id, trip_type, truck_id, driver_id, planned_date, delivery_mode, zone_id, delivery_fee, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [woId, t.tripType, t.truckId ?? null, t.driverId ?? null, plannedDate, mode, site.zone_id, fee, actor.id]);
  for (const l of t.lines) {
    await tx.query('INSERT INTO trip_lines (trip_id, pallet_type_id, condition, qty_planned) VALUES ($1,$2,$3,$4)', [trip.id, l.palletTypeId ?? pt, l.condition, l.qty]);
  }
  for (const h of t.helperIds) await tx.query('INSERT INTO trip_helpers (trip_id, employee_id) VALUES ($1,$2)', [trip.id, h]);
  if (wo.status === 'planned') await tx.query(`UPDATE work_orders SET status='in_progress' WHERE id=$1`, [woId]);
  if (so.status === 'scheduled') await tx.query(`UPDATE sales_orders SET status='in_progress' WHERE id=$1`, [so.id]);
  await audit(tx, actor, 'trip.create', 'trip', trip.id, null, { ...trip, lines: t.lines }, ctx);
  return trip;
}

export async function getTrip(tx: Tx, actor: Actor, id: string) {
  if (actor.roles.some((r) => r === 'DRIVER' || r === 'HELPER')) { requirePermission(actor, P.TRIP_OWN); await assertTripAssignedTo(tx, actor, id); }
  else requirePermission(actor, P.TRIP_READ);
  const t = await maybe<any>(tx, `SELECT t.*, tr.plate_no, e.full_name AS driver_name, wo.wo_no, so.so_no, so.site_id, so.client_id, s.name AS site_name, c.legal_name AS client_name
                                    FROM trips t JOIN work_orders wo ON wo.id=t.work_order_id JOIN sales_orders so ON so.id = wo.sales_order_id
                                    JOIN client_sites s ON s.id = so.site_id JOIN clients c ON c.id = so.client_id
                                    LEFT JOIN trucks tr ON tr.id=t.truck_id LEFT JOIN employees e ON e.id=t.driver_id WHERE t.id=$1`, [id]);
  if (!t) throw new NotFound('trip not found');
  const [lines, events, voucher, dr, gp, photos] = await Promise.all([
    many(tx, 'SELECT * FROM trip_lines WHERE trip_id=$1 ORDER BY condition', [id]),
    many(tx, 'SELECT * FROM trip_events WHERE trip_id=$1 ORDER BY at', [id]),
    maybe(tx, `SELECT * FROM vouchers WHERE trip_id=$1 AND status NOT IN ('void','rejected')`, [id]),
    maybe(tx, `SELECT * FROM delivery_receipts WHERE trip_id=$1 AND status <> 'void'`, [id]),
    maybe(tx, `SELECT * FROM gate_passes WHERE trip_id=$1 AND status <> 'void'`, [id]),
    many(tx, 'SELECT id, stage, taken_at_device, lat, lng, flags FROM pod_photos WHERE trip_id=$1 ORDER BY uploaded_at', [id]),
  ]);
  return { ...t, lines, events, voucher, dr, gatePass: gp, photos };
}
export async function listTrips(tx: Tx, actor: Actor, filter: { date?: string } = {}) {
  if (actor.roles.some((r) => r === 'DRIVER' || r === 'HELPER')) {
    requirePermission(actor, P.TRIP_OWN);
    return many(tx, `SELECT t.* FROM trips t WHERE (t.driver_id = $1 OR EXISTS (SELECT 1 FROM trip_helpers h WHERE h.trip_id=t.id AND h.employee_id=$1))
                       AND t.status NOT IN ('closed','cancelled') ORDER BY t.planned_date`, [actor.employeeId ?? null]);
  }
  requirePermission(actor, P.TRIP_READ);
  return many(tx, `SELECT t.*, tr.plate_no, s.name AS site_name, c.code AS client_code, q.planned AS qty_planned
                     FROM trips t JOIN work_orders wo ON wo.id=t.work_order_id JOIN sales_orders so ON so.id=wo.sales_order_id
                     JOIN client_sites s ON s.id=so.site_id JOIN clients c ON c.id=so.client_id LEFT JOIN trucks tr ON tr.id=t.truck_id
                     LEFT JOIN v_trip_qty q ON q.trip_id=t.id
                    WHERE ($1::date IS NULL OR t.planned_date = $1) ORDER BY t.planned_date DESC, t.trip_no DESC LIMIT 500`, [filter.date ?? null]);
}

export async function cancelTrip(tx: Tx, actor: Actor, id: string, reason: string, ctx: RequestCtx = {}) {
  if (!reason?.trim()) throw new AppError('reason required', 422);
  const t = await lockTrip(tx, id);
  const v = await maybe<any>(tx, `SELECT * FROM vouchers WHERE trip_id=$1 AND status NOT IN ('void','rejected')`, [id]);
  if (v?.status === 'released') throw new AppError('the voucher cash is released; liquidate or void the voucher first', 409);
  await transition(tx, actor, t, 'cancelled', {}, ctx);
  await tx.query(`UPDATE trips SET cancel_reason=$2 WHERE id=$1`, [id, reason]);
  if (v) await tx.query(`UPDATE vouchers SET status='void', void_reason=$2 WHERE id=$1`, [v.id, `trip cancelled: ${reason}`]);
  await tx.query(`UPDATE delivery_receipts SET status='void', void_reason=$2 WHERE trip_id=$1 AND status='issued'`, [id, `trip cancelled: ${reason}`]);
  await tx.query(`UPDATE gate_passes SET status='void', void_reason=$2 WHERE trip_id=$1 AND status='issued'`, [id, `trip cancelled: ${reason}`]);
}

// ---- vouchers (BR-04, BR-23, BR-27) --------------------------------------------------------------------------
export async function requestVoucher(tx: Tx, actor: Actor, tripId: string, input: { voucherNo: string; budgetAmount: string }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.VOUCHER_REQUEST);
  const t = await lockTrip(tx, tripId);
  if (!t.voucher_required) throw new RuleViolation('BR-26', 'a client pickup needs no voucher');
  if (t.status !== 'planned') throw new AppError(`trip is ${t.status}`, 409);
  if (!/^\d+(\.\d{1,2})?$/.test(input.budgetAmount)) throw new AppError('budget must be an amount', 422);
  const ownerRaised = actor.roles.includes('OWNER');
  // BR-27: the Owner's own request is auto-approved and flagged; Finance still releases it.
  const v = await one(tx,
    `INSERT INTO vouchers (voucher_no, trip_id, budget_amount, requested_by, owner_raised, status, approved_by, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.voucherNo, tripId, input.budgetAmount, actor.id, ownerRaised, ownerRaised ? 'approved' : 'requested', ownerRaised ? actor.id : null, ownerRaised ? new Date() : null]);
  await audit(tx, actor, 'voucher.request', 'voucher', v.id, null, v, ctx);
  if (ownerRaised) {
    await transition(tx, actor, t, 'budget_approved', {}, ctx);
    await requestApproval(tx, { entityType: 'voucher_release', entityId: v.id, permission: P.TRIP_RELEASE_BUDGET,
      summary: `Release voucher ${v.voucher_no}, trip ${t.trip_no}, ₱${v.budget_amount} (Owner-raised)`, link: `/trips/${tripId}`, requestedBy: actor.id });
  } else {
    await requestApproval(tx, { entityType: 'voucher', entityId: v.id, permission: P.TRIP_APPROVE_BUDGET,
      summary: `Voucher ${v.voucher_no}, trip ${t.trip_no}, ₱${v.budget_amount}`, link: `/trips/${tripId}`, requestedBy: actor.id });
  }
  return v;
}
export async function decideVoucher(tx: Tx, actor: Actor, voucherId: string, decision: 'approve' | 'reject', note: string | null, ctx: RequestCtx = {}) {
  requirePermission(actor, P.TRIP_APPROVE_BUDGET);
  const v = await one<any>(tx, 'SELECT * FROM vouchers WHERE id=$1 FOR UPDATE', [voucherId]);
  if (v.status !== 'requested') throw new AppError(`voucher is ${v.status}`, 409);
  assertNotSelf(actor, v.requested_by);
  const t = await lockTrip(tx, v.trip_id);
  if (decision === 'approve') {
    const after = await one(tx, `UPDATE vouchers SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *`, [voucherId, actor.id]);
    await transition(tx, actor, t, 'budget_approved', {}, ctx);
    await closeApproval(tx, actor, 'voucher', voucherId, 'approved', note);
    await requestApproval(tx, { entityType: 'voucher_release', entityId: voucherId, permission: P.TRIP_RELEASE_BUDGET,
      summary: `Release voucher ${v.voucher_no}, trip ${t.trip_no}, ₱${v.budget_amount}`, link: `/trips/${t.id}`, requestedBy: v.requested_by });
    await audit(tx, actor, 'voucher.approve', 'voucher', voucherId, v, after, ctx);
    return after;
  }
  if (!note?.trim()) throw new AppError('a reason is required to reject', 422);
  const after = await one(tx, `UPDATE vouchers SET status='rejected', void_reason=$2 WHERE id=$1 RETURNING *`, [voucherId, note]);
  await closeApproval(tx, actor, 'voucher', voucherId, 'rejected', note);
  await audit(tx, actor, 'voucher.reject', 'voucher', voucherId, v, after, ctx);
  return after;
}
registerDecisionHandler('voucher', (tx, a, id, d, n, c) => decideVoucher(tx, a, id, d, n, c).then(() => {}));

export async function releaseVoucher(tx: Tx, actor: Actor, voucherId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.TRIP_RELEASE_BUDGET);
  const v = await one<any>(tx, 'SELECT * FROM vouchers WHERE id=$1 FOR UPDATE', [voucherId]);
  if (v.status !== 'approved') throw new AppError(`voucher is ${v.status}`, 409);
  assertNotSelf(actor, v.requested_by, v.approved_by);         // requester ≠ approver ≠ releaser (also a DB CHECK)
  const t = await lockTrip(tx, v.trip_id);
  const after = await one(tx, `UPDATE vouchers SET status='released', released_by=$2, released_at=now() WHERE id=$1 RETURNING *`, [voucherId, actor.id]);
  await transition(tx, actor, t, 'budget_released', {}, ctx);
  await closeApproval(tx, actor, 'voucher_release', voucherId, 'approved', null);
  await audit(tx, actor, 'voucher.release', 'voucher', voucherId, v, after, ctx);
  return after;
}
registerDecisionHandler('voucher_release', async (tx, a, id, d, n, c) => {
  if (d === 'approve') await releaseVoucher(tx, a, id, c);
  else throw new AppError('Finance releases or leaves the voucher; to stop it, the requester voids it', 409);
});
export async function liquidateVoucher(tx: Tx, actor: Actor, voucherId: string, actualAmount: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.VOUCHER_REQUEST);
  const v = await one<any>(tx, 'SELECT * FROM vouchers WHERE id=$1 FOR UPDATE', [voucherId]);
  if (v.status !== 'released') throw new AppError(`voucher is ${v.status}`, 409);
  const after = await one(tx, `UPDATE vouchers SET status='liquidated', actual_amount=$2, liquidated_at=now() WHERE id=$1 RETURNING *`, [voucherId, actualAmount]);
  await audit(tx, actor, 'voucher.liquidate', 'voucher', voucherId, v, after, ctx);
  return after;
}
/** A voided voucher can be re-issued for the same trip (one live voucher per trip, partial unique index). */
export async function voidVoucher(tx: Tx, actor: Actor, voucherId: string, reason: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.VOUCHER_REQUEST);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  const v = await one<any>(tx, 'SELECT * FROM vouchers WHERE id=$1 FOR UPDATE', [voucherId]);
  if (['void', 'rejected', 'liquidated'].includes(v.status)) throw new AppError(`voucher is ${v.status}`, 409);
  const t = await lockTrip(tx, v.trip_id);
  if (!['planned', 'budget_approved', 'budget_released'].includes(t.status)) throw new AppError('the trip has left the plant; liquidate instead', 409);
  const after = await one(tx, `UPDATE vouchers SET status='void', void_reason=$2 WHERE id=$1 RETURNING *`, [voucherId, reason]);
  await tx.query(`UPDATE approval_requests SET status='cancelled' WHERE entity_id=$1 AND status='pending'`, [voucherId]);
  if (t.status !== 'planned') {
    await tx.query(`UPDATE trips SET status='planned' WHERE id=$1`, [t.id]);   // budget must be approved again for the new voucher
    await audit(tx, actor, 'trip.budget_reset', 'trip', t.id, { status: t.status }, { status: 'planned' }, ctx);
  }
  await audit(tx, actor, 'voucher.void', 'voucher', voucherId, v, after, ctx);
  return after;
}

// ---- DR and gate pass (BR-04, BR-13, BR-22) ------------------------------------------------------------------
export async function issueDR(tx: Tx, actor: Actor, tripId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.DR_ISSUE);
  const t = await lockTrip(tx, tripId);
  if (!['delivery', 'pickup'].includes(t.trip_type)) throw new AppError('a DR is issued for deliveries and client pickups', 422);
  if (['dispatched', 'at_site', 'delivered', 'returned', 'closed', 'cancelled'].includes(t.status)) throw new AppError(`trip is ${t.status}`, 409);
  const so = await one<any>(tx, 'SELECT so.* FROM sales_orders so JOIN work_orders wo ON wo.sales_order_id = so.id WHERE wo.id=$1', [t.work_order_id]);
  const q = await one<{ planned: number }>(tx, 'SELECT planned::int FROM v_trip_qty WHERE trip_id=$1', [tripId]);
  const dr = await one(tx, `INSERT INTO delivery_receipts (trip_id, sales_order_id, client_id, site_id, qty, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tripId, so.id, so.client_id, so.site_id, q.planned, actor.id]);
  await audit(tx, actor, 'dr.issue', 'delivery_receipt', dr.id, null, dr, ctx);
  return dr;
}
export async function voidDR(tx: Tx, actor: Actor, drId: string, reason: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.DR_VOID);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  const dr = await one<any>(tx, 'SELECT * FROM delivery_receipts WHERE id=$1 FOR UPDATE', [drId]);
  if (dr.status === 'void') throw new AppError('already void', 409);
  if (dr.status === 'received') throw new AppError('a received DR has ledger postings; reverse them (BR-14) before voiding', 409);
  const after = await one(tx, `UPDATE delivery_receipts SET status='void', void_reason=$2 WHERE id=$1 RETURNING *`, [drId, reason]);
  await audit(tx, actor, 'dr.void', 'delivery_receipt', drId, dr, after, ctx);
  return after;
}
/** BR-22: attach the Crystal Report–printed copy (number + scan). The system DR number stays primary. */
export async function attachExternalDR(tx: Tx, actor: Actor, drId: string, externalNo: string, fileId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.DR_ISSUE);
  const after = await one(tx, `UPDATE delivery_receipts SET external_dr_no=$2, external_dr_file_id=$3 WHERE id=$1 AND status <> 'void' RETURNING *`, [drId, externalNo, fileId]);
  await audit(tx, actor, 'dr.attach_external', 'delivery_receipt', drId, null, { external_dr_no: externalNo }, ctx);
  return after;
}
export async function issueGatePass(tx: Tx, actor: Actor, tripId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.DR_ISSUE);
  const t = await lockTrip(tx, tripId);
  if (['dispatched', 'at_site', 'delivered', 'returned', 'closed', 'cancelled'].includes(t.status)) throw new AppError(`trip is ${t.status}`, 409);
  const q = await one<{ planned: number }>(tx, 'SELECT planned::int FROM v_trip_qty WHERE trip_id=$1', [tripId]);
  const qty = t.trip_type === 'return' ? 0 : q.planned;     // a return truck leaves the plant empty
  const gp = await one(tx, 'INSERT INTO gate_passes (trip_id, qty) VALUES ($1,$2) RETURNING *', [tripId, qty]);
  await audit(tx, actor, 'gatepass.issue', 'gate_pass', gp.id, null, gp, ctx);
  return gp;
}

// ---- loading, gate, dispatch ---------------------------------------------------------------------------------
export async function startLoading(tx: Tx, actor: Actor, tripId: string, ctx: RequestCtx = {}) {
  const t = await lockTrip(tx, tripId);
  return transition(tx, actor, t, 'loading', {}, ctx);
}
export async function recordLoaded(tx: Tx, actor: Actor, tripId: string, lines: Array<{ lineId: string; qtyLoaded: number }>, ctx: RequestCtx = {}) {
  requirePermission(actor, P.TRIP_DISPATCH);
  const t = await lockTrip(tx, tripId);
  if (t.status !== 'loading') throw new AppError('loaded quantities are recorded while the trip is loading', 409);
  for (const l of lines) {
    if (!Number.isInteger(l.qtyLoaded) || l.qtyLoaded < 0) throw new AppError('quantity must be a whole number', 422);
    const r = await tx.query('UPDATE trip_lines SET qty_loaded=$3 WHERE id=$1 AND trip_id=$2', [l.lineId, tripId, l.qtyLoaded]);
    if (r.rowCount !== 1) throw new NotFound('trip line not found');
  }
  await audit(tx, actor, 'trip.loaded', 'trip', tripId, null, { lines }, ctx);
}

/**
 * Guard at the gate (§5 M5): scans the QR, confirms quantity and plate, records time out. BR-03/BR-04/BR-26 checked here.
 * Delivery: plant → in_transit. Pickup: no ledger movement until the signed DR (BR-26). Return: the truck leaves empty.
 */
export async function verifyGatePass(tx: Tx, actor: Actor, tripId: string, input: { plateNo?: string | null; qty: number }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.GATEPASS_VERIFY);
  const t = await lockTrip(tx, tripId);
  if (t.status !== 'loading') throw new AppError(`trip is ${t.status}`, 409);
  const gp = await maybe<any>(tx, `SELECT * FROM gate_passes WHERE trip_id=$1 AND status='issued' FOR UPDATE`, [tripId]);
  const dr = await maybe<any>(tx, `SELECT * FROM delivery_receipts WHERE trip_id=$1 AND status <> 'void'`, [tripId]);
  const v = await maybe<any>(tx, `SELECT * FROM vouchers WHERE trip_id=$1 AND status NOT IN ('void','rejected')`, [tripId]);
  const truck = t.truck_id ? await one<any>(tx, 'SELECT * FROM trucks WHERE id=$1', [t.truck_id]) : null;
  const lines = await many<any>(tx, 'SELECT * FROM trip_lines WHERE trip_id=$1', [tripId]);
  if (t.trip_type === 'return') {
    const missing = [!gp && 'gate pass', !(v && ['released', 'liquidated'].includes(v.status)) && 'released voucher'].filter(Boolean);
    if (missing.length) throw new RuleViolation('BR-04', `cannot dispatch, missing: ${missing.join(', ')}`);
  } else {
    try {
      assertCanDispatch({
        hasTicket: !!t.trip_no, voucherRequired: t.voucher_required, voucherReleased: !!v && ['released', 'liquidated'].includes(v.status),
        drIssued: !!dr, gatePassIssued: !!gp,
        lines: lines.map((l) => ({ palletTypeId: l.pallet_type_id, condition: l.condition, qtyLoaded: l.qty_loaded ?? 0 })),
        truckCapacity: truck?.capacity_pallets ?? 240,
      });
    } catch (e) { throw new RuleViolation((e as Error).message.includes('capacity') ? 'BR-03' : 'BR-04', (e as Error).message); }
    const loaded = lines.reduce((s, l) => s + (l.qty_loaded ?? 0), 0);
    if (input.qty !== loaded) throw new AppError(`gate count ${input.qty} does not match loaded ${loaded}`, 422, 'gate_mismatch');
  }
  if (truck && input.plateNo && input.plateNo.replace(/\s/g, '').toUpperCase() !== truck.plate_no.replace(/\s/g, '').toUpperCase()) {
    throw new AppError(`plate ${input.plateNo} is not the planned truck ${truck.plate_no}`, 422, 'gate_mismatch');
  }
  await tx.query(`UPDATE gate_passes SET status='verified', verified_by=$2, time_out=now(), plate_confirmed=$3 WHERE id=$1`, [gp.id, actor.id, input.plateNo ?? null]);
  await tx.query(`INSERT INTO trip_events (trip_id, event, at, recorded_by) VALUES ($1,'departed_plant',now(),$2) ON CONFLICT DO NOTHING`, [tripId, actor.id]);
  const after = await transition(tx, actor, t, 'dispatched', {}, ctx);
  if (t.trip_type === 'delivery' || t.trip_type === 'internal') await postDispatch(tx, tripId, actor);
  await audit(tx, actor, 'gatepass.verify', 'gate_pass', gp.id, null, { plate: input.plateNo, qty: input.qty }, ctx);
  return after;
}

// ---- field: events, photos, signed receipt -------------------------------------------------------------------
const EVENT_TO_STATUS: Record<string, TripStatus | undefined> = { arrived_site: 'at_site', returned_plant: 'returned' };

export async function recordTripEvent(tx: Tx, actor: Actor, tripId: string, input: { event: string; deviceAt?: string | null; lat?: number | null; lng?: number | null }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.TRIP_OWN);
  await assertTripAssignedTo(tx, actor, tripId);
  const t = await lockTrip(tx, tripId);
  const at = new Date();
  await tx.query(`INSERT INTO trip_events (trip_id, event, at, device_at, recorded_by, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tripId, input.event, at, input.deviceAt ?? null, actor.id, input.lat ?? null, input.lng ?? null]);
  await audit(tx, actor, `trip.event.${input.event}`, 'trip', tripId, null, { device_at: input.deviceAt, lat: input.lat, lng: input.lng }, ctx);
  const to = EVENT_TO_STATUS[input.event];
  if (to === 'at_site' && t.status === 'dispatched') await transition(tx, actor, t, 'at_site', {}, ctx);
  if (to === 'returned' && t.status === 'delivered') {
    await transition(tx, actor, t, 'returned', {}, ctx);
    if (t.trip_type === 'return') await postReturnArrival(tx, tripId, at, actor);
  }
  if (input.event === 'departed_site' && t.status === 'at_site' && t.trip_type === 'delivery') await tryCompleteDelivery(tx, actor, tripId, ctx);
  return { ok: true };
}

/** POD photo metadata (the file itself is uploaded through the signed-URL flow). BR-20 max per stage, BR-25 flags. */
export async function recordPodPhoto(tx: Tx, actor: Actor, tripId: string, input: { stage: 'loaded' | 'unloaded' | 'damage' | 'other'; fileId: string; takenAtDevice: string; lat: number; lng: number; gpsAccuracyM?: number | null }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.POD_UPLOAD);
  await assertTripAssignedTo(tx, actor, tripId);
  const max = Number((await maybe<{ value: number }>(tx, `SELECT value FROM settings WHERE key='pod.max_photos_per_stage'`))?.value ?? 2);
  const n = await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM pod_photos WHERE trip_id=$1 AND stage=$2', [tripId, input.stage]);
  if (['loaded', 'unloaded'].includes(input.stage) && n.n >= max) throw new RuleViolation('BR-20', `at most ${max} ${input.stage} photos`);
  const site = await maybe<any>(tx, `SELECT s.lat, s.lng, s.geofence_m FROM trips t JOIN work_orders wo ON wo.id=t.work_order_id
                                       JOIN sales_orders so ON so.id=wo.sales_order_id JOIN client_sites s ON s.id=so.site_id WHERE t.id=$1`, [tripId]);
  const skew = Number((await maybe<{ value: number }>(tx, `SELECT value FROM settings WHERE key='pod.clock_skew_minutes'`))?.value ?? 10);
  // Unloaded/damage photos are taken at the client site, so only they are compared with the site geofence.
  const flags = photoFlags({ lat: input.lat, lng: input.lng, accuracyM: input.gpsAccuracyM, takenAtDevice: new Date(input.takenAtDevice), serverNow: new Date(),
    site: input.stage === 'loaded' ? null : site ? { lat: site.lat == null ? null : Number(site.lat), lng: site.lng == null ? null : Number(site.lng), geofenceM: site.geofence_m } : null,
    clockSkewMinutes: skew });
  const row = await one(tx, `INSERT INTO pod_photos (trip_id, stage, file_id, taken_at_device, lat, lng, gps_accuracy_m, captured_in_app, flags, uploaded_by)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9) RETURNING id, stage, flags`,
    [tripId, input.stage, input.fileId, input.takenAtDevice, input.lat, input.lng, input.gpsAccuracyM ?? null, flags, actor.id]);
  await audit(tx, actor, 'pod.photo', 'trip', tripId, null, { photo_id: row.id, stage: input.stage, flags }, ctx);
  if (flags.length) {
    const { notify, holdersOf } = await import('./approvals');
    for (const u of await holdersOf(tx, P.WO_APPROVE)) await notify(tx, u, { kind: 'photo_flagged', title: 'Delivery photo flagged for review', body: `${flags.join(', ')}`, link: `/trips/${tripId}`, channels: ['in_app'] });
  }
  return row;
}

/**
 * Signed DR (§5 M5). In the app: the driver records receiver name + signature and the delivered quantities at the site.
 * On paper: the Deployment Officer enters the received date/time later and attaches the scan. Either way, once the proof
 * of delivery is complete (BR-20, incl. time-out) the trip becomes delivered and pallets move to the site; the signed-
 * receipt time is the billing start (BR-06).
 */
export async function recordSignedDR(tx: Tx, actor: Actor, tripId: string, input: {
  receiverName: string; signatureFileId: string; receivedAt?: string | null; delivered: Array<{ lineId: string; qtyDelivered: number }>;
}, ctx: RequestCtx = {}) {
  requirePermission(actor, P.DR_RECEIVE);
  await assertTripAssignedTo(tx, actor, tripId);
  const t = await lockTrip(tx, tripId);
  const expected = t.trip_type === 'pickup' ? 'dispatched' : 'at_site';
  if (t.status !== expected) throw new AppError(`trip is ${t.status}; the signed DR is recorded when it is ${expected}`, 409);
  if (!input.receiverName?.trim()) throw new AppError('receiver name required', 422);
  const dr = await one<any>(tx, `SELECT * FROM delivery_receipts WHERE trip_id=$1 AND status <> 'void' FOR UPDATE`, [tripId]);
  const isField = actor.roles.some((r) => r === 'DRIVER' || r === 'HELPER');
  const receivedAt = isField || !input.receivedAt ? new Date() : new Date(input.receivedAt);   // field: server time; paper: entered time
  if (receivedAt.getTime() > Date.now() + 60_000) throw new AppError('received time cannot be in the future', 422);
  for (const l of input.delivered) {
    if (!Number.isInteger(l.qtyDelivered) || l.qtyDelivered < 0) throw new AppError('quantity must be a whole number', 422);
    const r = await tx.query('UPDATE trip_lines SET qty_delivered=$3 WHERE id=$1 AND trip_id=$2 AND $3 <= COALESCE(qty_loaded, 0)', [l.lineId, tripId, l.qtyDelivered]);
    if (r.rowCount !== 1) throw new AppError('delivered quantity exceeds the loaded quantity of that line', 422);
  }
  if (t.trip_type === 'pickup') {
    await tx.query(`UPDATE trip_lines SET qty_delivered = qty_loaded WHERE trip_id=$1`, [tripId]);
  }
  await tx.query(`UPDATE delivery_receipts SET receiver_name=$2, receiver_signature_file_id=$3, received_at=$4,
                    delivered_at = COALESCE(delivered_at, $4), status = 'delivered' WHERE id=$1`, [dr.id, input.receiverName, input.signatureFileId, receivedAt]);
  await audit(tx, actor, 'dr.signed', 'delivery_receipt', dr.id, { status: dr.status }, { receiver_name: input.receiverName, received_at: receivedAt, via: isField ? 'app' : 'paper' }, ctx);
  if (t.trip_type === 'pickup') {
    await transition(tx, actor, t, 'delivered', {}, ctx);            // DR_RECEIVE per the pickup table
    await postPickupHandover(tx, tripId, actor);
    return { delivered: true };
  }
  return { delivered: await tryCompleteDelivery(tx, actor, tripId, ctx) };
}

/** at_site → delivered once the proof of delivery is complete; posts the delivery in the same transaction. */
async function tryCompleteDelivery(tx: Tx, actor: Actor, tripId: string, ctx: RequestCtx): Promise<boolean> {
  const t = await lockTrip(tx, tripId);
  const dr = await maybe<any>(tx, `SELECT * FROM delivery_receipts WHERE trip_id=$1 AND status <> 'void'`, [tripId]);
  const timeOut = await maybe(tx, `SELECT 1 FROM trip_events WHERE trip_id=$1 AND event='departed_site'`, [tripId]);
  if (t.status !== 'at_site' || !dr?.received_at || !timeOut) return false;
  // at_site → delivered is a TRIP_OWN step; the Deployment Officer may complete it for a paper DR (dr.receive).
  if (!can(actor, P.TRIP_OWN) && !can(actor, P.DR_RECEIVE)) throw new Forbidden('missing trips.own');
  await postDelivery(tx, tripId, actor);                             // asserts BR-20 first; throws if incomplete
  await transition(tx, actor, t, 'delivered', { permOverride: true }, ctx);
  return true;
}

export async function closeTrip(tx: Tx, actor: Actor, tripId: string, ctx: RequestCtx = {}) {
  const t = await lockTrip(tx, tripId);
  const carrying = await maybe(tx, 'SELECT 1 FROM v_trip_in_transit WHERE trip_id=$1', [tripId]);
  if (carrying) throw new AppError('the trip still carries pallets in transit', 409);
  return transition(tx, actor, t, 'closed', {}, ctx);
}

// ---- returns / dehire (BR-06) --------------------------------------------------------------------------------
export const ReturnInput = z.object({
  clientId: z.string().uuid(), siteId: z.string().uuid(), returnMode: z.enum(['rppc_pickup', 'client_delivers']),
  classifiedAt: z.enum(['client_site', 'rppc_plant']), tripId: z.string().uuid().optional().nullable(), auditId: z.string().uuid().optional().nullable(),
  receivedAt: z.string(), clientRepName: z.string().optional().nullable(), clientAckFileId: z.string().uuid().optional().nullable(),
  lines: z.array(z.object({ palletTypeId: z.string().uuid().optional(), condition: z.enum(['A', 'B', 'C', 'D', 'E', 'BER', 'lost']), qty: z.number().int().positive() })).min(1),
});
export async function createReturnReceipt(tx: Tx, actor: Actor, input: z.input<typeof ReturnInput>, ctx: RequestCtx = {}) {
  requirePermission(actor, P.RETURN_RECORD);
  const r = ReturnInput.parse(input);
  if (r.returnMode === 'client_delivers' && r.classifiedAt !== 'rppc_plant') throw new AppError('a plant delivery is classified at the plant', 422);
  if (r.returnMode === 'rppc_pickup' && !r.tripId) throw new AppError('an RPPC pickup return needs its trip', 422);
  if (r.tripId) {
    const t = await one<any>(tx, 'SELECT trip_type, status FROM trips WHERE id=$1', [r.tripId]);
    if (t.trip_type !== 'return') throw new AppError('the trip must be a return trip', 422);
  }
  const pt = (await one<{ id: string }>(tx, `SELECT id FROM pallet_types WHERE code='ECR-1200x1000'`)).id;
  const rr = await one(tx,
    `INSERT INTO return_receipts (client_id, site_id, return_mode, classified_at, audit_id, trip_id, received_at, received_by, client_rep_name, client_ack_file_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [r.clientId, r.siteId, r.returnMode, r.classifiedAt, r.auditId ?? null, r.tripId ?? null, r.receivedAt, actor.id, r.clientRepName ?? null, r.clientAckFileId ?? null]);
  for (const l of r.lines) await tx.query('INSERT INTO return_receipt_lines (return_receipt_id, pallet_type_id, condition, qty) VALUES ($1,$2,$3,$4)', [rr.id, l.palletTypeId ?? pt, l.condition, l.qty]);
  await audit(tx, actor, 'rr.create', 'return_receipt', rr.id, null, { ...rr, lines: r.lines }, ctx);
  return rr;
}
export async function receiveReturn(tx: Tx, actor: Actor, rrId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.RETURN_RECORD);
  const rr = await one<any>(tx, 'SELECT * FROM return_receipts WHERE id=$1 FOR UPDATE', [rrId]);
  if (rr.status !== 'draft') throw new AppError(`return receipt is ${rr.status}`, 409);
  // §18 assumption 4: when RPPC collects, the client acknowledges the count.
  if (rr.return_mode === 'rppc_pickup' && !rr.client_rep_name) throw new AppError('the client representative acknowledges the count when RPPC collects', 422);
  await postReturn(tx, rrId, actor);
  if (rr.trip_id) {
    const t = await lockTrip(tx, rr.trip_id);
    if (t.status === 'at_site') await transition(tx, actor, t, 'delivered', { permOverride: true }, ctx);   // collected
  }
  return one(tx, 'SELECT * FROM return_receipts WHERE id=$1', [rrId]);
}
