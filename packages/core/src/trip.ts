// §10.4 trip state machines, verbatim from the spec.
import { P, Permission } from './rbac';

export type TripType = 'delivery' | 'pickup' | 'return' | 'internal';
export type TripStatus = 'planned' | 'budget_approved' | 'budget_released' | 'loading' | 'dispatched'
  | 'at_site' | 'delivered' | 'returned' | 'closed' | 'cancelled';
type Transitions = Record<TripStatus, Partial<Record<TripStatus, Permission>>>;

const WITH_VOUCHER: Transitions = {
  planned:         { budget_approved: P.TRIP_APPROVE_BUDGET, cancelled: P.TRIP_WRITE },
  budget_approved: { budget_released: P.TRIP_RELEASE_BUDGET, cancelled: P.TRIP_WRITE },
  budget_released: { loading: P.TRIP_DISPATCH, cancelled: P.TRIP_WRITE },
  loading:         { dispatched: P.GATEPASS_VERIFY },          // guard verifies the gate pass at the gate
  dispatched:      { at_site: P.TRIP_OWN },
  at_site:         { delivered: P.TRIP_OWN },
  delivered:       { returned: P.TRIP_OWN },
  returned:        { closed: P.TRIP_WRITE },
  closed: {}, cancelled: {},
};
const NO_VOUCHER_PICKUP: Transitions = {
  planned:         { loading: P.TRIP_DISPATCH, cancelled: P.TRIP_WRITE },
  budget_approved: {}, budget_released: {},
  loading:         { dispatched: P.GATEPASS_VERIFY },
  dispatched:      { delivered: P.DR_RECEIVE },                // Deployment Officer records the client's signed DR at the plant
  at_site: {}, returned: {},
  delivered:       { closed: P.TRIP_WRITE },
  closed: {}, cancelled: {},
};
export const transitionsFor = (t: TripType): Transitions => (t === 'pickup' ? NO_VOUCHER_PICKUP : WITH_VOUCHER);

export interface TripLineQty { palletTypeId: string; condition: string; qtyLoaded: number }
export interface DispatchContext {
  hasTicket: boolean; voucherRequired: boolean; voucherReleased: boolean; drIssued: boolean; gatePassIssued: boolean;
  lines: TripLineQty[]; truckCapacity: number;
}

/** BR-03 / BR-04 / BR-26. Capacity is checked on the total of all lines. */
export function assertCanDispatch(c: DispatchContext): void {
  const total = c.lines.reduce((s, l) => s + l.qtyLoaded, 0);
  if (total <= 0) throw new Error('nothing loaded');
  if (total > c.truckCapacity) throw new Error(`load ${total} exceeds truck capacity ${c.truckCapacity}`);
  const missing = [
    !c.hasTicket && 'trip ticket', c.voucherRequired && !c.voucherReleased && 'released voucher',
    !c.drIssued && 'delivery receipt', !c.gatePassIssued && 'gate pass',
  ].filter(Boolean);
  if (missing.length) throw new Error(`cannot dispatch, missing: ${missing.join(', ')}`);
}

export interface PodEvidence {
  loadedPhotos: number; unloadedPhotos: number; photosMissingGeoOrTime: number;
  receiverName?: string; hasSignature: boolean;
  timeIn?: Date; timeOut?: Date;
}
/** BR-20 (minimums from settings: pod.min_loaded_photos, pod.min_unloaded_photos; default 1 each, max 2).
 *  A client pickup is handed over at the plant: it needs loaded photos, receiver and signature, but no site time-in/out or unloading photos. */
export function assertPodComplete(e: PodEvidence, tripType: TripType, min = { loaded: 1, unloaded: 1 }): void {
  const pickup = tripType === 'pickup';
  const gaps = [
    e.loadedPhotos < min.loaded && `loaded photos (${e.loadedPhotos}/${min.loaded})`,
    !pickup && e.unloadedPhotos < min.unloaded && `unloaded photos (${e.unloadedPhotos}/${min.unloaded})`,
    e.photosMissingGeoOrTime > 0 && `${e.photosMissingGeoOrTime} photo(s) without GPS or timestamp`,
    !e.receiverName && 'receiver name', !e.hasSignature && 'signature',
    !pickup && !e.timeIn && 'time-in', !pickup && !e.timeOut && 'time-out',
  ].filter(Boolean);
  if (gaps.length) throw new Error(`proof of delivery incomplete: ${gaps.join(', ')}`);
}

// ---- additions (not in the §10.4 reference) -------------------------------------------------------------
/** Returns the permission a transition needs, or throws if the transition does not exist for this trip type. */
export function transitionPermission(t: TripType, from: TripStatus, to: TripStatus): Permission {
  const perm = transitionsFor(t)[from]?.[to];
  if (!perm) throw new Error(`trip ${t}: no transition ${from} → ${to}`);
  return perm;
}
