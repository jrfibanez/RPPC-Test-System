// §5 M7 billing summary, §7.6 rental computation, BR-06/07/08/13/18/28, §12 export.
import crypto from 'node:crypto';
import { type Actor, P, requirePermission, assertNotSelf, AppError, NotFound, RuleViolation, billingPeriodFrom, nextPeriodStart, type CutoffSetting, vatOf } from '@rppc/core';
import { type Tx, one, maybe, many } from '../pool';
import { audit, type RequestCtx } from '../audit';
import { requestApproval, closeApproval, registerDecisionHandler } from './approvals';

/** §7.6 rental query, verbatim except for positional parameters. One row per rate term; term_id NULL = unpriced days. */
export const RENTAL_SQL = `
WITH days AS (
  SELECT b.day, SUM(b.qty_on_hand) AS pallets
  FROM inventory_locations l
  CROSS JOIN pallet_types pt
  CROSS JOIN LATERAL fn_location_daily_balance(l.id, pt.id, $2::date, $3::date) b
  WHERE l.site_id = $1
  GROUP BY b.day
), priced AS (
  SELECT d.day, d.pallets, t.id AS term_id, t.rate_per_pallet_day
  FROM days d
  LEFT JOIN site_rate_terms t
         ON t.site_id = $1 AND t.status = 'active'
        AND d.day BETWEEN t.effective_from AND COALESCE(t.effective_to, 'infinity'::date)
  WHERE d.pallets > 0
)
SELECT term_id, rate_per_pallet_day,
       SUM(pallets)                                           AS pallet_days,
       ROUND(SUM(pallets) * rate_per_pallet_day, 2)           AS rental_amount,
       COUNT(*) FILTER (WHERE term_id IS NULL)                AS unpriced_days,
       MIN(day) AS first_day, MAX(day) AS last_day
FROM priced
GROUP BY term_id, rate_per_pallet_day
ORDER BY MIN(day)`;

export interface RentalRow { term_id: string | null; rate_per_pallet_day: string | null; pallet_days: number; rental_amount: string | null; unpriced_days: number; first_day: string; last_day: string }
export async function computeRental(tx: Tx, siteId: string, start: string, end: string): Promise<{ rows: RentalRow[]; unpricedDays: number }> {
  const rows = await many<RentalRow>(tx, RENTAL_SQL, [siteId, start, end]);
  return { rows, unpricedDays: rows.reduce((s, r) => s + Number(r.unpriced_days), 0) };
}

/** Next period for a site: from the day after the previous live summary (or `firstStart`) through the cutoff (BR-07). */
export async function nextPeriodForSite(tx: Tx, siteId: string, firstStart?: string) {
  const site = await one<any>(tx, 'SELECT client_id FROM client_sites WHERE id=$1', [siteId]);
  const last = await maybe<{ period_end: string }>(tx, `SELECT period_end FROM billing_summaries WHERE site_id=$1 AND status <> 'void' ORDER BY period_end DESC LIMIT 1`, [siteId]);
  let start = last ? nextPeriodStart(last.period_end) : firstStart;
  if (!start) {
    const first = await maybe<{ d: string }>(tx, `SELECT min((m.occurred_at AT TIME ZONE 'Asia/Manila')::date)::text AS d FROM pallet_movements m JOIN inventory_locations l ON l.id = m.to_location_id WHERE l.site_id=$1`, [siteId]);
    if (!first?.d) throw new AppError('no pallets were ever delivered to this site', 422);
    start = first.d;
  }
  const settings = (await many<any>(tx, 'SELECT cutoff_day, effective_from FROM client_cutoff_settings WHERE client_id=$1', [site.client_id]))
    .map((r): CutoffSetting => ({ cutoffDay: r.cutoff_day, effectiveFrom: r.effective_from }));
  return billingPeriodFrom(start, settings);
}

/** Build a draft summary: rental per rate term, delivery fees of charged trips received in the period, damage/lost charges. */
export async function generateSummary(tx: Tx, actor: Actor, siteId: string, opts: { periodStart?: string; periodEnd?: string } = {}, ctx: RequestCtx = {}) {
  requirePermission(actor, P.BILL_WRITE);
  const site = await maybe<any>(tx, 'SELECT * FROM client_sites WHERE id=$1', [siteId]);
  if (!site) throw new NotFound('site not found');
  const period = opts.periodStart && opts.periodEnd ? { start: opts.periodStart, end: opts.periodEnd } : await nextPeriodForSite(tx, siteId, opts.periodStart);
  const { rows, unpricedDays } = await computeRental(tx, siteId, period.start, period.end);

  const bs = await one<any>(tx, `INSERT INTO billing_summaries (client_id, site_id, period_start, period_end, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [site.client_id, siteId, period.start, period.end, actor.id]);   // EXCLUDE refuses an overlap with a live summary

  let palletDays = 0, rental = 0n, other = 0n;
  const cents = (s: string) => BigInt(Math.round(Number(s) * 100));      // amounts from SQL are already rounded to 2dp
  for (const r of rows) {
    palletDays += Number(r.pallet_days);
    if (!r.term_id) continue;                                            // unpriced: never billed at ₱0 silently
    const src = await one<any>(tx, `SELECT t.source_type, COALESCE(p.proposal_no, c.contract_no) AS doc FROM site_rate_terms t
                                     LEFT JOIN proposals p ON p.id=t.proposal_id LEFT JOIN contracts c ON c.id=t.contract_id WHERE t.id=$1`, [r.term_id]);
    await tx.query(`INSERT INTO billing_summary_lines (summary_id, line_type, rate_term_id, ref_type, ref_id, description, qty, unit_rate, amount)
                    VALUES ($1,'rental',$2,'site_rate_term',$2,$3,$4,$5,$6)`,
      [bs.id, r.term_id, `Pallet rental ${r.first_day}–${r.last_day} (${src.source_type} ${src.doc})`, r.pallet_days, r.rate_per_pallet_day, r.rental_amount]);
    rental += cents(r.rental_amount!);
  }
  // BR-05: delivery fee per charged trip whose signed DR was received in the period (Manila date).
  const fees = await many<any>(tx, `SELECT t.id, t.trip_no, t.delivery_fee, dr.dr_no FROM trips t JOIN delivery_receipts dr ON dr.trip_id = t.id AND dr.status='received'
                                     WHERE dr.site_id=$1 AND t.delivery_mode='charged' AND t.delivery_fee > 0
                                       AND (dr.received_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3`, [siteId, period.start, period.end]);
  for (const f of fees) {
    await tx.query(`INSERT INTO billing_summary_lines (summary_id, line_type, ref_type, ref_id, description, qty, unit_rate, amount) VALUES ($1,'delivery_fee','trip',$2,$3,1,$4,$4)`,
      [bs.id, f.id, `Delivery fee, trip ${f.trip_no} / DR ${f.dr_no}`, f.delivery_fee]);
    other += cents(f.delivery_fee);
  }
  // BR-12: damage classes on returns received in the period, priced from the rate term's proposal/contract damage matrix.
  const dmg = await many<any>(tx, `SELECT rr.id, rr.rr_no, l.condition, sum(l.qty)::int AS qty, rr.received_at FROM return_receipts rr JOIN return_receipt_lines l ON l.return_receipt_id = rr.id
                                    WHERE rr.site_id=$1 AND rr.status='received' AND l.condition <> 'A'
                                      AND (rr.received_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3 GROUP BY rr.id, rr.rr_no, l.condition, rr.received_at`, [siteId, period.start, period.end]);
  for (const d of dmg) {
    const matrix = await maybe<any>(tx, `SELECT COALESCE(c.damage_rates, p.damage_rates) AS rates FROM site_rate_terms t LEFT JOIN contracts c ON c.id=t.contract_id LEFT JOIN proposals p ON p.id=t.proposal_id
                                          WHERE t.site_id=$1 AND t.status='active' AND ($2 AT TIME ZONE 'Asia/Manila')::date BETWEEN t.effective_from AND COALESCE(t.effective_to,'infinity'::date)`, [siteId, d.received_at]);
    const rate: string | null | undefined = matrix?.rates?.[d.condition];
    if (rate == null) throw new RuleViolation('BR-12', `no ${d.condition === 'lost' ? 'replacement cost' : 'damage rate'} for class ${d.condition} on ${d.rr_no}; set it on the contract`);
    const amount = (Math.round(Number(rate) * 100) * d.qty / 100).toFixed(2);
    await tx.query(`INSERT INTO billing_summary_lines (summary_id, line_type, ref_type, ref_id, description, qty, unit_rate, amount) VALUES ($1,$2,'return_receipt',$3,$4,$5,$6,$7)`,
      [bs.id, d.condition === 'lost' ? 'lost' : 'repair', d.id, `${d.condition === 'lost' ? 'Lost pallets' : `Damage class ${d.condition}`}, ${d.rr_no}`, d.qty, rate, amount]);
    other += cents(amount);
  }
  const after = await one(tx, `UPDATE billing_summaries SET pallet_days=$2, rental_amount=$3, other_charges=$4 WHERE id=$1 RETURNING *`,
    [bs.id, palletDays, (Number(rental) / 100).toFixed(2), (Number(other) / 100).toFixed(2)]);
  await audit(tx, actor, 'billing.generate', 'billing_summary', bs.id, null, { ...after, unpriced_days: unpricedDays }, ctx);
  return { summary: after, unpricedDays };
}

async function lockBs(tx: Tx, id: string) {
  const b = await maybe<any>(tx, 'SELECT * FROM billing_summaries WHERE id=$1 FOR UPDATE', [id]);
  if (!b) throw new NotFound('billing summary not found');
  return b;
}
async function setStatus(tx: Tx, actor: Actor, b: any, status: string, extra: Record<string, unknown>, action: string, ctx: RequestCtx) {
  const keys = Object.keys(extra);
  const sets = ['status=$2', ...keys.map((k, i) => `${k}=$${i + 3}`)].join(', ');
  const after = await one(tx, `UPDATE billing_summaries SET ${sets} WHERE id=$1 RETURNING *`, [b.id, status, ...keys.map((k) => extra[k])]);
  await audit(tx, actor, action, 'billing_summary', b.id, { status: b.status }, after, ctx);
  return after;
}

/** Billing submits the draft for the Operations review (requests an approval for OPS_MGR). */
export async function submitForReview(tx: Tx, actor: Actor, id: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.BILL_WRITE);
  const b = await lockBs(tx, id);
  if (b.status !== 'draft') throw new AppError(`summary is ${b.status}`, 409);
  const { unpricedDays } = await computeRental(tx, b.site_id, b.period_start, b.period_end);
  if (unpricedDays > 0) throw new RuleViolation('BR-28', `${unpricedDays} day(s) with pallets on site have no rate term; add the term before finalising`);
  await requestApproval(tx, { entityType: 'billing_summary', entityId: id, permission: P.BILL_REVIEW,
    summary: `Billing summary ${b.bs_no} ${b.period_start}–${b.period_end}, ₱${b.total_vat_ex} (VAT-ex)`, link: `/billing/${id}`, requestedBy: actor.id });
  await audit(tx, actor, 'billing.submit_review', 'billing_summary', id, null, null, ctx);
}
/** BR-28: a summary with unpriced days cannot be finalised; Operations review re-checks it. */
export async function reviewSummary(tx: Tx, actor: Actor, id: string, decision: 'approve' | 'reject' = 'approve', note: string | null = null, ctx: RequestCtx = {}) {
  requirePermission(actor, P.BILL_REVIEW);
  const b = await lockBs(tx, id);
  if (b.status !== 'draft') throw new AppError(`summary is ${b.status}`, 409);
  assertNotSelf(actor, b.created_by);
  if (decision === 'reject') {
    if (!note?.trim()) throw new AppError('a reason is required to reject', 422);
    await closeApproval(tx, actor, 'billing_summary', id, 'rejected', note);
    await audit(tx, actor, 'billing.review_rejected', 'billing_summary', id, null, { note }, ctx);
    return b;
  }
  const { unpricedDays } = await computeRental(tx, b.site_id, b.period_start, b.period_end);
  if (unpricedDays > 0) throw new RuleViolation('BR-28', `${unpricedDays} day(s) with pallets on site have no rate term`);
  await closeApproval(tx, actor, 'billing_summary', id, 'approved', note);
  return setStatus(tx, actor, b, 'ops_reviewed', {}, 'billing.review', ctx);
}
registerDecisionHandler('billing_summary', (tx, a, id, d, n, c) => reviewSummary(tx, a, id, d, n, c).then(() => {}));

export async function sendToClient(tx: Tx, actor: Actor, id: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.BILL_WRITE);
  const b = await lockBs(tx, id);
  if (b.status !== 'ops_reviewed') throw new AppError('only an Operations-reviewed summary is sent', 409);
  return setStatus(tx, actor, b, 'sent_to_client', { sent_at: new Date() }, 'billing.send', ctx);
}
/** BR-07: the summary must be client-approved before Finance invoices. */
export async function recordClientApproval(tx: Tx, actor: Actor, id: string, input: { approverName: string; fileId?: string | null; approvedAt?: string }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.BILL_WRITE);
  const b = await lockBs(tx, id);
  if (b.status !== 'sent_to_client') throw new AppError(`summary is ${b.status}`, 409);
  if (!input.approverName?.trim()) throw new AppError('client approver name required', 422);
  return setStatus(tx, actor, b, 'client_approved', { client_approved_at: input.approvedAt ? new Date(input.approvedAt) : new Date(), client_approver_name: input.approverName, approval_file_id: input.fileId ?? null }, 'billing.client_approved', ctx);
}
export async function recordDispute(tx: Tx, actor: Actor, id: string, reason: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.BILL_WRITE);
  const b = await lockBs(tx, id);
  if (!['sent_to_client', 'invoiced'].includes(b.status)) throw new AppError(`summary is ${b.status}`, 409);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  return setStatus(tx, actor, b, 'disputed', {}, 'billing.disputed', ctx);
}

/** §12 export pack row set: one CSV per call, VAT computed here (rates stored VAT-exclusive). Step-up required (§8.1). */
export async function exportSummaries(tx: Tx, actor: Actor, ids: string[], ctx: RequestCtx = {}) {
  requirePermission(actor, P.BILL_EXPORT);
  const header = ['bs_no', 'client_code', 'client_name', 'site', 'period_start', 'period_end', 'pallet_days', 'rental_vat_ex', 'other_charges_vat_ex', 'total_vat_ex', 'vat_12', 'total_vat_inc', 'dr_list', 'client_approval_ref'];
  const lines = [header.join(',')];
  for (const id of ids) {
    const b = await lockBs(tx, id);
    if (!['client_approved', 'exported'].includes(b.status)) throw new AppError(`${b.bs_no} is ${b.status}; only client-approved summaries are exported`, 409);
    const c = await one<any>(tx, 'SELECT code, legal_name FROM clients WHERE id=$1', [b.client_id]);
    const s = await one<any>(tx, 'SELECT name FROM client_sites WHERE id=$1', [b.site_id]);
    const drs = await many<{ dr_no: string }>(tx, `SELECT dr_no FROM delivery_receipts WHERE site_id=$1 AND status='received'
                                                  AND (received_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $2 AND $3 ORDER BY dr_no`, [b.site_id, b.period_start, b.period_end]);
    const { vat, gross } = vatOf(b.total_vat_ex);
    const cells = [b.bs_no, c.code, c.legal_name, s.name, b.period_start, b.period_end, String(b.pallet_days), b.rental_amount, b.other_charges, b.total_vat_ex, vat, gross,
      drs.map((d) => d.dr_no).join(' '), `${b.client_approver_name ?? ''} ${b.client_approved_at ? new Date(b.client_approved_at).toISOString() : ''}`.trim()];
    lines.push(cells.map(csvCell).join(','));
    if (b.status === 'client_approved') await setStatus(tx, actor, b, 'exported', { exported_at: new Date(), exported_by: actor.id }, 'billing.export', ctx);
  }
  const csv = lines.join('\r\n') + '\r\n';
  const sha = crypto.createHash('sha256').update(csv).digest('hex');
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const filename = `billing-export-${stamp}-${sha.slice(0, 8)}.csv`;
  await tx.query(`INSERT INTO exports (kind, filename, sha256, row_count, filters, exported_by) VALUES ('billing',$1,$2,$3,$4,$5)`, [filename, sha, ids.length, JSON.stringify({ ids }), actor.id]);
  await audit(tx, actor, 'export.billing', 'export', null, null, { filename, sha256: sha, ids }, ctx);
  return { filename, csv, sha256: sha };
}
export function csvCell(v: string): string {
  const s = v ?? '';
  // Prevent spreadsheet formula injection, and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** After SAP invoicing: record invoice no. and receipt date; BR-08 dispute deadline = 5 business days (holiday calendar). */
export async function recordInvoice(tx: Tx, actor: Actor, id: string, input: { invoiceRef: string; invoiceReceivedOn: string }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.BILL_WRITE);
  const b = await lockBs(tx, id);
  if (b.status !== 'exported') throw new AppError(`summary is ${b.status}`, 409);
  const { d } = await one<{ d: string }>(tx, 'SELECT add_business_days($1::date, 5)::text AS d', [input.invoiceReceivedOn]);
  return setStatus(tx, actor, b, 'invoiced', { invoice_ref: input.invoiceRef, invoice_received_on: input.invoiceReceivedOn, dispute_deadline: d }, 'billing.invoiced', ctx);
}

/** BR-13: never edited or deleted, voided with a reason. A billed (exported/invoiced) one needs break-glass. */
export async function voidSummary(tx: Tx, actor: Actor, id: string, reason: string, ctx: RequestCtx = {}) {
  const b = await lockBs(tx, id);
  if (['exported', 'invoiced'].includes(b.status)) requirePermission(actor, P.BREAK_GLASS, { stepUp: true });
  else requirePermission(actor, P.BILL_WRITE);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  if (b.status === 'void') throw new AppError('already void', 409);
  await tx.query(`UPDATE approval_requests SET status='cancelled' WHERE entity_type='billing_summary' AND entity_id=$1 AND status='pending'`, [id]);
  const after = await setStatus(tx, actor, b, 'void', { void_reason: reason }, 'billing.void', ctx);
  if (['exported', 'invoiced'].includes(b.status)) {
    const { notify, holdersOf } = await import('./approvals');
    for (const u of await holdersOf(tx, P.PAY_FIN_CHECK)) await notify(tx, u, { kind: 'break_glass', title: 'Break-glass: billed summary voided', body: `${b.bs_no}: ${reason}`, link: `/billing/${id}`, channels: ['in_app', 'email'] });
  }
  return after;
}

export async function listSummaries(tx: Tx, actor: Actor) {
  if (actor.roles.includes('CLIENT')) {
    requirePermission(actor, P.PORTAL_READ);
    return many(tx, `SELECT * FROM billing_summaries WHERE client_id=$1 AND status IN ('sent_to_client','client_approved','disputed','exported','invoiced') ORDER BY period_end DESC`, [actor.clientScope ?? null]);
  }
  requirePermission(actor, P.BILL_READ);
  return many(tx, `SELECT b.*, c.code AS client_code, s.name AS site_name FROM billing_summaries b JOIN clients c ON c.id=b.client_id JOIN client_sites s ON s.id=b.site_id ORDER BY b.period_end DESC, b.bs_no DESC LIMIT 500`);
}
export async function getSummary(tx: Tx, actor: Actor, id: string) {
  const b = await maybe<any>(tx, 'SELECT * FROM billing_summaries WHERE id=$1', [id]);
  if (!b) throw new NotFound();
  if (actor.roles.includes('CLIENT')) {
    requirePermission(actor, P.PORTAL_READ);
    if (b.client_id !== actor.clientScope || ['draft', 'ops_reviewed', 'void'].includes(b.status)) throw new NotFound();
  } else requirePermission(actor, P.BILL_READ);
  return { ...b, lines: await many(tx, 'SELECT * FROM billing_summary_lines WHERE summary_id=$1 ORDER BY line_type, description', [id]) };
}
