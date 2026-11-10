import { z } from 'zod';
import { sessionRoute, body } from '@/lib/route';
import { auth } from '@rppc/db';
const In = z.object({ password: z.string().min(1), code: z.string().optional() });
export const POST = sessionRoute('own re-authentication (step-up)', async (req, actor, tx, ctx) => {
  const b = In.parse(await body(req)); await auth.stepUp(tx, actor, b.password, b.code, ctx); return { ok: true };
});
