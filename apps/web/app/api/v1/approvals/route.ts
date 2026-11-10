import { sessionRoute } from '@/lib/route';
import { approvals } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = sessionRoute('own approvals inbox (filtered by the permissions the user holds)', async (_req, actor, tx) => approvals.inbox(tx, actor));
