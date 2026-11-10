import { z } from 'zod';
import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { billing } from '@rppc/db';
const In = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });
// Permission-gated, step-up, audited, filename-versioned with the file's sha256 (§12).
export const POST = route(P.BILL_EXPORT, async (req, actor, tx, ctx) => {
  const r = await billing.exportSummaries(tx, actor, In.parse(await body(req)).ids, ctx);
  return new Response(r.csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${r.filename}"`, 'x-sha256': r.sha256 } });
});
