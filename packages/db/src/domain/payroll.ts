// Phase 2: §5 M8 production capture and piece-rate payroll; §10.7 computation; BR-15/16/17/21/24.
import { type Actor, P, requirePermission, assertNotSelf, AppError, NotFound, Forbidden, RuleViolation, payWeekOf, can } from '@rppc/core';
import { type Tx, one, maybe, many } from '../pool';
import { audit, SYSTEM, type RequestCtx } from '../audit';
import { requestApproval, closeApproval, registerDecisionHandler } from './approvals';

/** §10.7: the rate in force that day, client-specific rate first. */
export async function rateFor(tx: Tx, activityId: string, clientId: string | null, workDate: string): Promise<string> {
  const r = await maybe<{ rate: string }>(tx,
    `SELECT r.rate FROM activity_rates r
      WHERE r.activity_id = $1 AND (r.client_id = $2 OR r.client_id IS NULL)
        AND r.effective_from <= $3 AND (r.effective_to IS NULL OR r.effective_to >= $3)
      ORDER BY (r.client_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1`, [activityId, clientId, workDate]);
  if (!r) throw new RuleViolation('BR-15', 'no rate in force for this activity on that date');
  return r.rate;
}

export async function setActivityRate(tx: Tx, actor: Actor, input: { activityId: string; clientId?: string | null; rate: string; effectiveFrom: string }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.RATES_MANAGE);                   // Owner only, step-up (§8.1)
  await tx.query(`UPDATE activity_rates SET effective_to = ($3::date - 1) WHERE activity_id=$1 AND client_id IS NOT DISTINCT FROM $2 AND effective_to IS NULL AND effective_from < $3`,
    [input.activityId, input.clientId ?? null, input.effectiveFrom]);
  const row = await one(tx, `INSERT INTO activity_rates (activity_id, client_id, rate, effective_from, set_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.activityId, input.clientId ?? null, input.rate, input.effectiveFrom, actor.id]);
  await audit(tx, actor, 'rate.activity_set', 'activity_rate', row.id, null, row, ctx);
  return row;
}
export async function setTripPayRate(tx: Tx, actor: Actor, crewRole: 'driver' | 'helper', amount: string, effectiveFrom: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.RATES_MANAGE);
  await tx.query(`UPDATE trip_pay_rates SET effective_to = ($2::date - 1) WHERE crew_role=$1 AND effective_to IS NULL AND effective_from < $2`, [crewRole, effectiveFrom]);
  const row = await one(tx, `INSERT INTO trip_pay_rates (crew_role, amount_per_trip, effective_from, set_by) VALUES ($1,$2,$3,$4) RETURNING *`, [crewRole, amount, effectiveFrom, actor.id]);
  await audit(tx, actor, 'rate.trip_pay_set', 'trip_pay_rate', row.id, null, row, ctx);
  return row;
}

/** Security encodes the paper output sheet (§5 M8); rate snapshotted at entry (BR-15). */
export async function encodeProduction(tx: Tx, actor: Actor, input: { workDate: string; workerId: string; activityId: string; clientId?: string | null; qty: string; sourceSheetFileId?: string | null }, ctx: RequestCtx = {}) {
  const self = actor.employeeId === input.workerId;
  if (self) {
    requirePermission(actor, P.PROD_ENTER_OWN);
    const on = await maybe<{ value: boolean }>(tx, `SELECT value FROM settings WHERE key='production.allow_self_entry'`);
    if (on?.value !== true) throw new Forbidden('self-entry of output is switched off');
  } else requirePermission(actor, P.PROD_ENTER_FOR);
  const rate = await rateFor(tx, input.activityId, input.clientId ?? null, input.workDate);
  const via = self ? 'self' : actor.roles.includes('GUARD') ? 'guard' : 'supervisor';
  const row = await one(tx,
    `INSERT INTO production_entries (work_date, worker_id, activity_id, client_id, qty, rate_snapshot, entered_by, entered_via, source_sheet_file_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted') RETURNING *`,
    [input.workDate, input.workerId, input.activityId, input.clientId ?? null, input.qty, rate, actor.id, via, input.sourceSheetFileId ?? null]);
  await requestApproval(tx, { entityType: 'production_entry', entityId: row.id, permission: P.PROD_APPROVE, summary: `Output ${input.workDate}: ${input.qty} × ₱${rate}`, link: `/production/${row.id}`, requestedBy: actor.id });
  await audit(tx, actor, 'production.encode', 'production_entry', row.id, null, row, ctx);
  return row;
}
/** Production Officer approves; the encoder cannot approve, nor can the payee (BR-21, §8.3). Rejected entries can be re-entered. */
export async function decideProduction(tx: Tx, actor: Actor, id: string, decision: 'approve' | 'reject', note: string | null, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PROD_APPROVE);
  const e = await maybe<any>(tx, 'SELECT * FROM production_entries WHERE id=$1 FOR UPDATE', [id]);
  if (!e) throw new NotFound();
  if (e.status !== 'submitted') throw new AppError(`entry is ${e.status}`, 409);
  assertNotSelf(actor, e.entered_by, e.worker_id);
  if (decision === 'reject' && !note?.trim()) throw new AppError('a reason is required to reject', 422);
  const after = await one(tx, decision === 'approve'
    ? `UPDATE production_entries SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *`
    : `UPDATE production_entries SET status='rejected', reject_reason=$2 WHERE id=$1 RETURNING *`, decision === 'approve' ? [id, actor.id] : [id, note]);
  await closeApproval(tx, actor, 'production_entry', id, decision === 'approve' ? 'approved' : 'rejected', note);
  await audit(tx, actor, `production.${decision}`, 'production_entry', id, e, after, ctx);
  return after;
}
registerDecisionHandler('production_entry', (tx, a, id, d, n, c) => decideProduction(tx, a, id, d, n, c).then(() => {}));

export async function ensurePeriod(tx: Tx, anyDateInWeek: string) {
  const w = payWeekOf(anyDateInWeek);
  return (await maybe<any>(tx, `SELECT * FROM payroll_periods WHERE pay_group='weekly_piece_rate' AND period_start=$1`, [w.start]))
    ?? one<any>(tx, `INSERT INTO payroll_periods (period_start, period_end, week_no, yr) VALUES ($1,$2,$3,$4) RETURNING *`, [w.start, w.end, w.weekNo, w.yr]);
}

/** The weekly system job (Saturday 06:00 PHT). No person computes payroll (BR-16). One transaction. */
export async function computePeriod(tx: Tx, periodId: string, jobName = 'weekly-payroll') {
  const p = await one<any>(tx, 'SELECT * FROM payroll_periods WHERE id=$1 FOR UPDATE', [periodId]);
  if (p.status !== 'open') throw new AppError(`period is ${p.status}`, 409);
  await tx.query(`INSERT INTO payroll_lines (period_id, employee_id, source, ref_id, description, qty, rate, amount)
    SELECT $1, e.worker_id, 'production', e.id, a.name, e.qty, e.rate_snapshot, e.amount
      FROM production_entries e JOIN production_activities a ON a.id = e.activity_id
     WHERE e.status = 'approved' AND e.work_date BETWEEN $2 AND $3`, [periodId, p.period_start, p.period_end]);
  await tx.query(`UPDATE production_entries SET status = 'locked' WHERE status = 'approved' AND work_date BETWEEN $1 AND $2`, [p.period_start, p.period_end]);
  // BR-17 / BR-26: flat pay per completed RPPC trip, dated by completion (Manila); client pickups earn no crew pay.
  await tx.query(`WITH crew AS (
      SELECT t.id AS trip_id, t.trip_no, t.driver_id AS employee_id, 'driver'::text AS crew_role, (t.completed_at AT TIME ZONE 'Asia/Manila')::date AS d
        FROM trips t WHERE t.completed_at IS NOT NULL AND t.status <> 'cancelled' AND t.trip_type <> 'pickup' AND t.driver_id IS NOT NULL
         AND (t.completed_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3
      UNION ALL
      SELECT t.id, t.trip_no, h.employee_id, 'helper', (t.completed_at AT TIME ZONE 'Asia/Manila')::date
        FROM trips t JOIN trip_helpers h ON h.trip_id = t.id
       WHERE t.completed_at IS NOT NULL AND t.status <> 'cancelled' AND t.trip_type <> 'pickup'
         AND (t.completed_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3)
    INSERT INTO payroll_lines (period_id, employee_id, source, ref_id, description, qty, rate, amount)
    SELECT $1, c.employee_id, 'trip', c.trip_id, 'Trip ' || c.trip_no, 1, r.amount_per_trip, r.amount_per_trip
      FROM crew c JOIN trip_pay_rates r ON r.crew_role = c.crew_role AND r.effective_from <= c.d AND (r.effective_to IS NULL OR r.effective_to >= c.d)
    ON CONFLICT DO NOTHING`, [periodId, p.period_start, p.period_end]);
  const after = await one(tx, `UPDATE payroll_periods SET status='computed', computed_at=now(), computed_by_job=$2,
      total_snapshot=(SELECT COALESCE(SUM(amount),0) FROM payroll_lines WHERE period_id=$1 AND voided_at IS NULL) WHERE id=$1 RETURNING *`, [periodId, jobName]);
  await audit(tx, SYSTEM, 'payroll.compute', 'payroll_period', periodId, { status: p.status }, after);
  for (const [perm, step] of [[P.PAY_PROD_VERIFY, 'production'], [P.PAY_SEC_VERIFY, 'security'], [P.PAY_HR_VERIFY, 'hr'], [P.PAY_FIN_CHECK, 'finance']] as const) {
    await notifyHolders(tx, perm, `Payroll week ${p.week_no} (${p.period_start}–${p.period_end}) ready for your ${step} sign-off: ₱${after.total_snapshot}`, `/payroll/${periodId}`);
  }
  return after;
}
async function notifyHolders(tx: Tx, perm: any, body: string, link: string) {
  const { notify, holdersOf } = await import('./approvals');
  for (const u of await holdersOf(tx, perm)) await notify(tx, u, { kind: 'payroll_signoff', title: 'Payroll sign-off needed', body, link, channels: ['in_app', 'push', 'email'] });
}

const STEP_PERM = { production: P.PAY_PROD_VERIFY, security: P.PAY_SEC_VERIFY, hr: P.PAY_HR_VERIFY, finance: P.PAY_FIN_CHECK } as const;
async function isPayee(tx: Tx, actor: Actor, periodId: string) {
  if (!actor.employeeId) return false;
  return !!(await maybe(tx, `SELECT 1 FROM payroll_lines WHERE period_id=$1 AND employee_id=$2 AND voided_at IS NULL`, [periodId, actor.employeeId]));
}

/** One of the four sign-offs (BR-16): given on the frozen total, one person per step per round, never by a payee. */
export async function signOff(tx: Tx, actor: Actor, periodId: string, step: keyof typeof STEP_PERM, totalSeen: string, note: string | null, ctx: RequestCtx = {}) {
  requirePermission(actor, STEP_PERM[step]);
  const p = await one<any>(tx, 'SELECT * FROM payroll_periods WHERE id=$1 FOR UPDATE', [periodId]);
  if (!['computed', 'verifying'].includes(p.status)) throw new AppError(`period is ${p.status}`, 409);
  if (await isPayee(tx, actor, periodId)) throw new Forbidden('segregation of duties: you cannot sign a period in which you are paid');
  if (Number(totalSeen).toFixed(2) !== Number(p.total_snapshot).toFixed(2)) throw new AppError(`the total you checked (₱${totalSeen}) is not the frozen total (₱${p.total_snapshot})`, 409, 'total_mismatch');
  await tx.query(`INSERT INTO payroll_verifications (period_id, round, step, verified_by, total_seen, note) VALUES ($1,$2,$3,$4,$5,$6)`, [periodId, p.round, step, actor.id, totalSeen, note]);
  if (p.status === 'computed') await tx.query(`UPDATE payroll_periods SET status='verifying' WHERE id=$1`, [periodId]);
  await audit(tx, actor, `payroll.signoff.${step}`, 'payroll_period', periodId, null, { round: p.round, total_seen: totalSeen }, ctx);
  const n = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM payroll_verifications WHERE period_id=$1 AND round=$2`, [periodId, p.round]);
  if (n.n === 4) await notifyHolders(tx, P.PAY_OWNER_APPROVE, `Payroll week ${p.week_no}: all four sign-offs done, ₱${p.total_snapshot}`, `/payroll/${periodId}`);
}

export async function ownerApprovePeriod(tx: Tx, actor: Actor, periodId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PAY_OWNER_APPROVE);                 // step-up enforced by STEP_UP_PERMISSIONS
  const p = await one<any>(tx, 'SELECT * FROM payroll_periods WHERE id=$1 FOR UPDATE', [periodId]);
  if (p.status !== 'verifying') throw new AppError(`period is ${p.status}`, 409);
  if (await isPayee(tx, actor, periodId)) throw new Forbidden('segregation of duties: you cannot approve a period in which you are paid');
  const steps = await many<{ step: string }>(tx, `SELECT step FROM payroll_verifications WHERE period_id=$1 AND round=$2 AND total_seen = $3`, [periodId, p.round, p.total_snapshot]);
  const missing = ['production', 'security', 'hr', 'finance'].filter((s) => !steps.some((x) => x.step === s));
  if (missing.length) throw new RuleViolation('BR-16', `missing sign-off(s): ${missing.join(', ')}`);
  const after = await one(tx, `UPDATE payroll_periods SET status='owner_approved', owner_approved_by=$2, owner_approved_at=now() WHERE id=$1 RETURNING *`, [periodId, actor.id]);
  await audit(tx, actor, 'payroll.owner_approve', 'payroll_period', periodId, { status: p.status }, after, ctx);
  return after;
}

/** BR-16: reopen only before paid; voids the system lines, unlocks entries, starts a new sign-off round. */
export async function reopenPeriod(tx: Tx, actor: Actor, periodId: string, reason: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PAY_REOPEN);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  const p = await one<any>(tx, 'SELECT * FROM payroll_periods WHERE id=$1 FOR UPDATE', [periodId]);
  if (['paid', 'locked', 'open'].includes(p.status)) throw new AppError(`a ${p.status} period cannot be reopened`, 409);
  await tx.query(`UPDATE payroll_lines SET voided_at=now(), void_reason=$2 WHERE period_id=$1 AND voided_at IS NULL AND source IN ('production','trip')`, [periodId, `reopened: ${reason}`]);
  await tx.query(`UPDATE production_entries SET status='approved' WHERE status='locked' AND work_date BETWEEN $1 AND $2`, [p.period_start, p.period_end]);
  const after = await one(tx, `UPDATE payroll_periods SET status='open', round=round+1, total_snapshot=NULL, owner_approved_by=NULL, owner_approved_at=NULL WHERE id=$1 RETURNING *`, [periodId]);
  await audit(tx, actor, 'payroll.reopen', 'payroll_period', periodId, { status: p.status, round: p.round }, { ...after, reason }, ctx);
  return after;
}

/** HR proposes an adjustment; only the Owner approves it (§5 M8). Stored as an approval request until approved. */
export async function proposeAdjustment(tx: Tx, actor: Actor, periodId: string, input: { employeeId: string; amount: string; description: string }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PAY_ADJUST);
  const p = await one<any>(tx, 'SELECT * FROM payroll_periods WHERE id=$1', [periodId]);
  if (!['open', 'computed', 'verifying'].includes(p.status)) throw new AppError(`period is ${p.status}`, 409);
  if (input.employeeId === actor.employeeId) throw new Forbidden('segregation of duties: you cannot adjust your own pay');
  const id = await requestApproval(tx, { entityType: 'payroll_adjustment', entityId: periodId, permission: P.PAY_ADJUST_APPROVE,
    summary: `Adjustment ₱${input.amount} for employee ${input.employeeId}: ${input.description}`, link: `/payroll/${periodId}`, requestedBy: actor.id });
  await tx.query(`UPDATE approval_requests SET decision_note=$2 WHERE id=$1`, [id, JSON.stringify(input)]);
  await audit(tx, actor, 'payroll.adjust_propose', 'payroll_period', periodId, null, input, ctx);
  return id;
}
export async function approveAdjustment(tx: Tx, actor: Actor, approvalId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PAY_ADJUST_APPROVE);
  const a = await one<any>(tx, `SELECT * FROM approval_requests WHERE id=$1 AND entity_type='payroll_adjustment' AND status='pending' FOR UPDATE`, [approvalId]);
  assertNotSelf(actor, a.requested_by);
  const input = JSON.parse(a.decision_note);
  if (input.employeeId === actor.employeeId) throw new Forbidden('segregation of duties: you cannot approve your own pay');
  const p = await one<any>(tx, 'SELECT * FROM payroll_periods WHERE id=$1 FOR UPDATE', [a.entity_id]);
  if (!['open', 'computed', 'verifying'].includes(p.status)) throw new AppError(`period is ${p.status}`, 409);
  await tx.query(`INSERT INTO payroll_lines (period_id, employee_id, source, description, amount, created_by, approved_by) VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
    [p.id, input.employeeId, input.description, input.amount, a.requested_by, actor.id]);
  await tx.query(`UPDATE approval_requests SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`, [approvalId, actor.id]);
  if (p.status !== 'open') {
    // The frozen total changed: earlier sign-offs no longer match, so a new round starts on the new total.
    await tx.query(`UPDATE payroll_periods SET round=round+1, status='computed', total_snapshot=(SELECT COALESCE(SUM(amount),0) FROM payroll_lines WHERE period_id=$1 AND voided_at IS NULL) WHERE id=$1`, [p.id]);
  }
  await audit(tx, actor, 'payroll.adjust_approve', 'payroll_period', p.id, null, input, ctx);
}

/** BR-24: HR hands out the cash, Security witnesses (different people), the worker acknowledges. */
export async function recordPayout(tx: Tx, actor: Actor, periodId: string, input: { employeeId: string; witnessUserId: string; acknowledged: boolean; signatureFileId?: string | null }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PAY_PAYOUT);
  const p = await one<any>(tx, 'SELECT * FROM payroll_periods WHERE id=$1 FOR UPDATE', [periodId]);
  if (!['owner_approved', 'paid'].includes(p.status)) throw new AppError('payout only after Owner approval', 409);
  const witness = await maybe(tx, `SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=$1 AND rp.permission_code='payroll.witness_payout'`, [input.witnessUserId]);
  if (!witness) throw new AppError('the witness must be Security', 422);
  const amt = await one<{ a: string }>(tx, `SELECT COALESCE(SUM(amount),0)::text AS a FROM payroll_lines WHERE period_id=$1 AND employee_id=$2 AND voided_at IS NULL`, [periodId, input.employeeId]);
  await tx.query(`INSERT INTO payroll_payouts (period_id, employee_id, amount, paid_by, witnessed_by, acknowledged, signature_file_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [periodId, input.employeeId, amt.a, actor.id, input.witnessUserId, input.acknowledged, input.signatureFileId ?? null]);
  if (p.status === 'owner_approved') await tx.query(`UPDATE payroll_periods SET status='paid' WHERE id=$1`, [periodId]);
  await audit(tx, actor, 'payroll.payout', 'payroll_period', periodId, null, { employee_id: input.employeeId, amount: amt.a, witness: input.witnessUserId }, ctx);
}

/** The Weekly Payroll Summary of the owner's Excel (§7.7). */
export async function weeklySummary(tx: Tx, actor: Actor) {
  requirePermission(actor, P.PAY_READ);
  return many(tx, `SELECT p.id, p.week_no, p.period_start, p.period_end, p.status, SUM(w.total) AS total_weekly_payroll, COUNT(*)::int AS no_of_manpower,
                          ROUND(AVG(w.total), 2) AS avg_per_manpower, MAX(w.total) AS highest_salary, MIN(w.total) AS lowest_salary
                     FROM payroll_periods p
                     JOIN (SELECT period_id, employee_id, SUM(amount) AS total FROM payroll_lines WHERE voided_at IS NULL GROUP BY period_id, employee_id) w ON w.period_id = p.id
                    GROUP BY p.id, p.week_no ORDER BY p.period_start`);
}
export async function myEarnings(tx: Tx, actor: Actor) {
  requirePermission(actor, P.PAY_READ_OWN);
  return many(tx, `SELECT l.*, p.period_start, p.period_end, p.status AS period_status FROM payroll_lines l JOIN payroll_periods p ON p.id=l.period_id
                    WHERE l.employee_id = $1 AND l.voided_at IS NULL ORDER BY p.period_start DESC`, [actor.employeeId ?? null]);
}
void can;
