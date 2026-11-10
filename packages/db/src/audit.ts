// Every state change writes an audit_log row in the same transaction (§8.5, CLAUDE.md rule 5).
// Never pass passwords, PINs, tokens, TOTP secrets or photos in before/after (rule 8).
import type { Tx } from './pool';
import type { Actor } from '@rppc/core';

export interface RequestCtx { ip?: string | null; userAgent?: string | null; requestId?: string | null }

const SECRET_KEYS = /pass(word)?|pin|token|secret|totp|otp|signature_data|photo_data/i;
function scrub(v: unknown): unknown {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(scrub);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : scrub(x)]));
}

export async function audit(
  tx: Tx, actor: Pick<Actor, 'id' | 'roles'> | null, action: string,
  entityType: string | null, entityId: string | null, before: unknown, after: unknown, ctx: RequestCtx = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (actor_id, actor_roles, action, entity_type, entity_id, before, after, ip, user_agent, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [actor?.id ?? null, actor?.roles ?? null, action, entityType, entityId,
     before == null ? null : JSON.stringify(scrub(before)), after == null ? null : JSON.stringify(scrub(after)),
     ctx.ip ?? null, ctx.userAgent ?? null, ctx.requestId ?? null],
  );
}

/** System actor for jobs (weekly payroll, reminders). It holds no roles and is never a user. */
export const SYSTEM = { id: null as unknown as string, roles: ['SYSTEM'] };
