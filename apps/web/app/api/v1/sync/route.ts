import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { sync, getPool } from '@rppc/db';
// Each op runs in its own transaction (sync.applyOps); the wrapper's transaction only authenticates.
export const POST = route(P.TRIP_OWN, async (req, actor) => sync.applyOps(getPool(), actor, await body(req)));
