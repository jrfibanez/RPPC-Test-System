import { route } from '@/lib/route';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
export const dynamic = 'force-dynamic';
// Scoped inside getTrip: a driver/helper only ever sees trips they are assigned to (404 otherwise).
export const GET = route(P.TRIP_OWN, async (_req, actor, tx, ctx) => trips.getTrip(tx, actor, ctx.params.id));
