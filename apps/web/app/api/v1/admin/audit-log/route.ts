import { route } from '@/lib/route';
import { P } from '@rppc/core';
export const dynamic = 'force-dynamic';
export const GET = route(P.AUDIT_READ, async (req, _a, tx) => {
  const raw = req.nextUrl.searchParams.get('before') ?? '9223372036854775807';
  const before = /^\d{1,19}$/.test(raw) ? raw : '9223372036854775807';   // bigint as text: no float precision loss
  return (await tx.query(`SELECT id, at, actor_id, actor_roles, action, entity_type, entity_id, after, ip, request_id FROM audit_log WHERE id < $1 ORDER BY id DESC LIMIT 200`, [before])).rows;
});
