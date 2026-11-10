import { z } from 'zod';
import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { ledger, masters } from '@rppc/db';
const In = z.object({ cutoverAt: z.string(), csv: z.string().optional(), rows: z.array(z.object({ siteId: z.string().uuid(), qty: z.number().int().positive(), condition: z.string().optional() })).optional() });
// §14 step 2: CSV columns site_id, qty[, condition]. Unknown condition mix is booked as A.
export const POST = route(P.INV_APPROVE, async (req, actor, tx, ctx) => {
  const b = In.parse(await body(req));
  const rows = b.rows ?? masters.parseCsv(b.csv ?? '').map((r) => ({ siteId: r.site_id, qty: Number(r.qty), condition: r.condition || undefined }));
  return ledger.importOpeningBalance(tx, actor, rows, b.cutoverAt, ctx);
});
