import { route } from '@/lib/route';
import { P } from '@rppc/core';
import { masters } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.CLIENT_READ, async (_req, actor, tx, ctx) => masters.getClient(tx, actor, ctx.params.id));
