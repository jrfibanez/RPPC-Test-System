import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { trips } from '@rppc/db';
export const POST = route(P.RETURN_RECORD, async (req, actor, tx, ctx) => trips.createReturnReceipt(tx, actor, await body(req), ctx));
