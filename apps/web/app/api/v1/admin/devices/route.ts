import { z } from 'zod';
import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { auth } from '@rppc/db';
const In = z.object({ userId: z.string().uuid(), label: z.string().min(1).max(100) });
export const POST = route(P.USERS_MANAGE, async (req, actor, tx, ctx) => { const b = In.parse(await body(req)); return { deviceId: await auth.enrollDevice(tx, actor, b.userId, b.label, ctx) }; });
