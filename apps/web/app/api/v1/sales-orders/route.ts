import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { commercial } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.SO_READ, async (_req, actor, tx) => commercial.listSalesOrders(tx, actor));
export const POST = route(P.SO_CREATE, async (req, actor, tx, ctx) => commercial.createSalesOrder(tx, actor, await body(req), ctx));
