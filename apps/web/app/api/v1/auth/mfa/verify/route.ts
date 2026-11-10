import { z } from 'zod';
import { sessionRoute, body } from '@/lib/route';
import { auth } from '@rppc/db';
const In = z.object({ code: z.string().min(6).max(20) });
export const POST = sessionRoute('own TOTP verification', async (req, actor, tx, ctx) => auth.mfaVerify(tx, actor, In.parse(await body(req)).code, ctx));
