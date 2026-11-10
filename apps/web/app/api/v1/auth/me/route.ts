import { sessionRoute } from '@/lib/route';
import { ROLE_PERMISSIONS } from '@rppc/core';
export const dynamic = 'force-dynamic';
export const GET = sessionRoute('own identity and permissions (for the UI; the server still checks every call)', async (_req, actor, tx) => {
  const u = (await tx.query('SELECT username, full_name, mfa_enabled FROM users WHERE id=$1', [actor.id])).rows[0];
  const perms = [...new Set(actor.roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []))];
  return { id: actor.id, ...u, roles: actor.roles, authMethod: actor.authMethod, mfaPassed: actor.mfaPassed, permissions: perms };
});
