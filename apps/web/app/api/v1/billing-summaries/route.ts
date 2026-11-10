import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { billing } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = route(P.BILL_READ, async (_req, actor, tx) => billing.listSummaries(tx, actor));
export const POST = route(P.BILL_WRITE, async (req, actor, tx, ctx) => { const b = await body(req); return billing.generateSummary(tx, actor, b.siteId, b, ctx); });
