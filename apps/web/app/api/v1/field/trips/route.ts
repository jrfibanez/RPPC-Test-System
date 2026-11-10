import { route } from '@/lib/route';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.TRIP_OWN, async (_req, actor, tx) => trips.listTrips(tx, actor));
