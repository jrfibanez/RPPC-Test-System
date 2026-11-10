import { z } from 'zod';
import { sessionRoute, body } from '@/lib/route';
import { approvals } from '@rppc/db';
import { NotFound } from '@rppc/core';
import '@/lib/handlers';
const In = z.object({ note: z.string().max(1000).optional().nullable() });
// The decision handler of each entity type checks the request's required_permission and segregation of duties.
export const POST = sessionRoute('decision on an approval request; decide() checks required_permission + SoD', async (req, actor, tx, ctx) => {
  const { id, action } = ctx.params;
  if (action !== 'approve' && action !== 'reject') throw new NotFound();
  await approvals.decide(tx, actor, id, action, In.parse(await body(req).catch(() => ({}))).note ?? null, ctx);
  return { ok: true };
});
