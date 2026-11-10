import { z } from 'zod';
import { route, body } from '@/lib/route';
import { P } from '@rppc/core';
import { masters } from '@rppc/db';
export const dynamic = 'force-dynamic';
const In = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().min(1), kind: z.string().default('national') });
export const GET = route(P.SETTINGS, async (_req, _a, tx) => (await tx.query('SELECT * FROM holidays ORDER BY hdate')).rows);
export const POST = route(P.SETTINGS, async (req, actor, tx, ctx) => { const b = In.parse(await body(req)); await masters.addHoliday(tx, actor, b.date, b.name, b.kind, ctx); return { ok: true }; });
