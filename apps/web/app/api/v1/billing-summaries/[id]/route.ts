import { route } from '@/lib/route';
import { P } from '@rppc/core';
import { billing } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.BILL_READ, async (_req, actor, tx, ctx) => billing.getSummary(tx, actor, ctx.params.id));
