import { sessionRoute } from '@/lib/route';
import { approvals } from '@rppc/db';
export const POST = sessionRoute('mark own notification read', async (_req, actor, tx, ctx) => { await approvals.markRead(tx, actor, ctx.params.id); return { ok: true }; });
