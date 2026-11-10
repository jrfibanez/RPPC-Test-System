import { sessionRoute } from '@/lib/route';
import { approvals } from '@rppc/db';
export const dynamic = 'force-dynamic';
export const GET = sessionRoute('own notifications', async (req, actor, tx) => approvals.myNotifications(tx, actor, req.nextUrl.searchParams.get('unread') === '1'));
