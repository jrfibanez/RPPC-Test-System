import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { masters } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.CLIENT_READ, async (_req, actor, tx) => masters.listClients(tx, actor));
export const POST = route(P.CLIENT_WRITE, async (req, actor, tx, ctx) => masters.createClient(tx, actor, await body(req), ctx));
