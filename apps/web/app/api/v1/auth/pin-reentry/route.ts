import { z } from 'zod';
import { sessionRoute, body } from '@/lib/route';
import { auth } from '@rppc/db';
const In = z.object({ pin: z.string().regex(/^\d{6}$/) });
export const POST = sessionRoute('own PIN re-entry', async (req, actor, tx, ctx) => { await auth.pinReentry(tx, actor, In.parse(await body(req)).pin, ctx); return { ok: true }; });
