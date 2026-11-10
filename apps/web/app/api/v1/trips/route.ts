import { route } from '@/lib/route';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
export const dynamic = 'force-dynamic';
// Drivers/helpers are scoped to their own trips inside listTrips (trips.own); office roles need trips.read.
export const GET = route(P.TRIP_READ, async (req, actor, tx) => trips.listTrips(tx, actor, { date: req.nextUrl.searchParams.get('date') ?? undefined }));
