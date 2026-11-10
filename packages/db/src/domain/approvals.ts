// §5 M13 approvals inbox and notifications; §10.8 requestApproval.
import { type Actor, type Permission, P, Forbidden, NotFound, AppError, requirePermission } from '@rppc/core';
import { type Tx, one, maybe, many } from '../pool';
import { audit, type RequestCtx } from '../audit';

export interface NotifyInput { kind: string; title: string; body?: string; link?: string; channels: string[] }

/** Queue a notification. Delivery (web push / email) is done by the notifier job; in_app is immediate. */
export async function notify(tx: Tx, userId: string, n: NotifyInput): Promise<void> {
  await tx.query(`INSERT INTO notifications (user_id, kind, title, body, link, channels) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, n.kind, n.title, n.body ?? null, n.link ?? null, n.channels]);
}

/** Holders of a permission (active users only), excluding one user id. */
export async function holdersOf(tx: Tx, perm: Permission, exclude?: string | null): Promise<string[]> {
  const rows = await many<{ user_id: string }>(tx,
    `SELECT DISTINCT ur.user_id FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN users u ON u.id = ur.user_id AND u.status = 'active'
      WHERE rp.permission_code = $1 AND ($2::uuid IS NULL OR ur.user_id <> $2)`, [perm, exclude ?? null]);
  return rows.map((r) => r.user_id);
}

// Anything that waits for an approver goes through here (voucher, SO, proposal, payroll step, ...).
export async function requestApproval(
  tx: Tx,
  p: { entityType: string; entityId: string; permission: Permission; summary: string; link: string; requestedBy: string },
): Promise<string> {
  // One pending request per entity and permission: a resubmission replaces the earlier one.
  await tx.query(`UPDATE approval_requests SET status='cancelled' WHERE entity_type=$1 AND entity_id=$2 AND required_permission=$3 AND status='pending'`,
    [p.entityType, p.entityId, p.permission]);
  const { id } = await one<{ id: string }>(tx,
    `INSERT INTO approval_requests (entity_type, entity_id, required_permission, summary, link, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.entityType, p.entityId, p.permission, p.summary, p.link, p.requestedBy]);
  for (const userId of await holdersOf(tx, p.permission, p.requestedBy)) {   // the requester is never notified as an approver
    await notify(tx, userId, { kind: 'approval_needed', title: 'Needs your approval', body: p.summary, link: p.link, channels: ['in_app', 'push', 'email'] });
  }
  return id;
}

/** Close the pending request(s) for an entity once the entity's own approve/reject endpoint has acted. */
export async function closeApproval(tx: Tx, actor: Actor, entityType: string, entityId: string, decision: 'approved' | 'rejected', note?: string | null) {
  const rows = await many<{ id: string; requested_by: string; summary: string; link: string }>(tx,
    `UPDATE approval_requests SET status=$3, decided_by=$4, decided_at=now(), decision_note=$5
      WHERE entity_type=$1 AND entity_id=$2 AND status='pending' RETURNING id, requested_by, summary, link`,
    [entityType, entityId, decision, actor.id, note ?? null]);
  for (const r of rows) {
    await notify(tx, r.requested_by, { kind: `request_${decision}`, title: `Your request was ${decision}`, body: note ? `${r.summary} — ${note}` : r.summary, link: r.link, channels: ['in_app', 'push'] });
  }
}

/** "Waiting for me": pending requests whose permission the actor holds, never the actor's own. */
export async function inbox(tx: Tx, actor: Actor) {
  return many(tx,
    `SELECT a.* FROM approval_requests a
      WHERE a.status='pending' AND a.requested_by <> $1
        AND a.required_permission IN (SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1)
      ORDER BY a.created_at`, [actor.id]);
}

export async function myNotifications(tx: Tx, actor: Actor, unreadOnly = false) {
  return many(tx, `SELECT * FROM notifications WHERE user_id=$1 ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`, [actor.id]);
}
export async function markRead(tx: Tx, actor: Actor, id: string) {
  await tx.query('UPDATE notifications SET read_at = now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL', [id, actor.id]);
}

/** Generic decision from the inbox: dispatches to the entity's own handler (which checks permission and SoD). */
export type DecisionHandler = (tx: Tx, actor: Actor, entityId: string, decision: 'approve' | 'reject', note: string | null, ctx: RequestCtx) => Promise<void>;
const handlers = new Map<string, DecisionHandler>();
export function registerDecisionHandler(entityType: string, h: DecisionHandler) { handlers.set(entityType, h); }

export async function decide(tx: Tx, actor: Actor, approvalId: string, decision: 'approve' | 'reject', note: string | null, ctx: RequestCtx = {}) {
  const a = await maybe<any>(tx, 'SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE', [approvalId]);
  if (!a) throw new NotFound();
  if (a.status !== 'pending') throw new AppError('already decided', 409, 'conflict');
  if (a.requested_by === actor.id) throw new Forbidden('segregation of duties: you cannot approve your own request');
  requirePermission(actor, a.required_permission);              // incl. PIN-session, MFA and step-up rules
  if (decision === 'reject' && !note?.trim()) throw new AppError('a reason is required to reject', 422, 'reason_required');
  const h = handlers.get(a.entity_type);
  if (!h) throw new AppError(`no handler for ${a.entity_type}`, 500);
  await h(tx, actor, a.entity_id, decision, note, ctx);
}

/**
 * Reminder job (§5 M13), every 30 min between 06:00 and 22:00 PHT:
 *   pending > 2 h and reminder_count < 3 → remind the approvers, reminder_count + 1
 *   pending > 4 h                         → FYI to OPS_MGR (cannot approve), once
 */
export async function runReminders(tx: Tx, now = new Date()): Promise<{ reminded: number; fyi: number }> {
  let reminded = 0, fyi = 0;
  const due = await many<any>(tx,
    `SELECT * FROM approval_requests WHERE status='pending' AND created_at < $1::timestamptz - interval '2 hours'
       AND reminder_count < 3 AND (last_reminded_at IS NULL OR last_reminded_at < $1::timestamptz - interval '2 hours')`, [now]);
  for (const a of due) {
    for (const u of await holdersOf(tx, a.required_permission, a.requested_by)) {
      await notify(tx, u, { kind: 'approval_reminder', title: 'Still waiting for your approval', body: a.summary, link: a.link, channels: ['in_app', 'push', 'email'] });
    }
    await tx.query('UPDATE approval_requests SET reminder_count = reminder_count + 1, last_reminded_at = $2 WHERE id=$1', [a.id, now]);
    reminded += 1;
  }
  const late = await many<any>(tx,
    `SELECT a.* FROM approval_requests a WHERE a.status='pending' AND a.created_at < $1::timestamptz - interval '4 hours'
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.kind='approval_fyi' AND n.link = a.link)`, [now]);
  for (const a of late) {
    const opsMgrs = await many<{ user_id: string }>(tx,
      `SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
        WHERE r.code = 'OPS_MGR' AND u.status = 'active'`);
    for (const m of opsMgrs) await notify(tx, m.user_id, { kind: 'approval_fyi', title: 'FYI: approval pending over 4 hours', body: a.summary, link: a.link, channels: ['in_app', 'email'] });
    fyi += 1;
  }
  return { reminded, fyi };
}

export { P };
