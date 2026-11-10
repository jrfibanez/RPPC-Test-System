import { actions } from '@/lib/actions';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
export const POST = actions({
  trips: { perm: P.TRIP_WRITE, run: (b, a, tx, c, id) => trips.createTrip(tx, a, id, b, c) },
  reschedule: { perm: P.TRIP_WRITE, run: (b, a, tx, c, id) => trips.rescheduleWorkOrder(tx, a, id, b.plannedDate, b.reason, b.note ?? null, c) },
});
