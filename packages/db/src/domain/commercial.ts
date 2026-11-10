// §5 M2 proposals & contracts, §7.3 site_rate_terms lifecycle (BR-10, BR-28), §5 M3 sales orders (BR-01, BR-02).
import { z } from 'zod';
import { type Actor, P, requirePermission, assertNotSelf, AppError, NotFound, RuleViolation, Forbidden, can } from '@rppc/core';
import { type Tx, one, maybe, many } from '../pool';
import { audit, type RequestCtx } from '../audit';
import { requestApproval, closeApproval, registerDecisionHandler } from './approvals';

/** BR-12 default damage matrix (VAT-exclusive). Lost = replacement cost (set per contract). */
export const DEFAULT_DAMAGE_RATES = { A: '0.00', B: '200.00', C: '400.00', D: '800.00', E: '1300.00', BER: '1300.00', lost: null as string | null };

async function lock<T = any>(tx: Tx, table: string, id: string): Promise<T> {
  const r = await maybe<T>(tx, `SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
  if (!r) throw new NotFound(`${table.replace(/s$/, '')} not found`);
  return r;
}

// ---- proposals ----------------------------------------------------------------------------------------------
export const ProposalInput = z.object({
  clientId: z.string().uuid(), siteId: z.string().uuid().optional().nullable(), attentionTo: z.string().optional().nullable(),
  palletTypeId: z.string().uuid().optional(), minQty: z.number().int().min(1).default(240),
  ratePerPalletDay: z.string().regex(/^\d+(\.\d{1,4})?$/), contractMonths: z.number().int().min(1).default(12),
  deliveryMode: z.enum(['free', 'charged']).default('charged'),
  damageRates: z.record(z.string().nullable()).optional(), terms: z.record(z.unknown()).default({}),
  validUntil: z.string(),
});
export async function createProposal(tx: Tx, actor: Actor, input: z.input<typeof ProposalInput>, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PROPOSAL_WRITE);
  const p = ProposalInput.parse(input);
  const pt = p.palletTypeId ?? (await one<{ id: string }>(tx, `SELECT id FROM pallet_types WHERE code='ECR-1200x1000'`)).id;
  if (p.siteId) await assertSiteOfClient(tx, p.siteId, p.clientId);
  const row = await one(tx,
    `INSERT INTO proposals (client_id, site_id, attention_to, pallet_type_id, min_qty, rate_per_pallet_day, contract_months, delivery_mode,
                            damage_rates, terms, valid_until, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [p.clientId, p.siteId ?? null, p.attentionTo ?? null, pt, p.minQty, p.ratePerPalletDay, p.contractMonths, p.deliveryMode,
     JSON.stringify(p.damageRates ?? DEFAULT_DAMAGE_RATES), JSON.stringify(p.terms), p.validUntil, actor.id]);
  await audit(tx, actor, 'proposal.create', 'proposal', row.id, null, row, ctx);
  return row;
}
async function assertSiteOfClient(tx: Tx, siteId: string, clientId: string) {
  const s = await maybe(tx, 'SELECT 1 FROM client_sites WHERE id=$1 AND client_id=$2', [siteId, clientId]);
  if (!s) throw new AppError('site does not belong to this client', 422);
}

export async function submitProposal(tx: Tx, actor: Actor, id: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PROPOSAL_WRITE);
  const p = await lock(tx, 'proposals', id);
  if (p.status !== 'draft') throw new AppError(`cannot submit a ${p.status} proposal`, 409);
  const after = await one(tx, `UPDATE proposals SET status='pending_approval', submitted_at=now() WHERE id=$1 RETURNING *`, [id]);
  await requestApproval(tx, { entityType: 'proposal', entityId: id, permission: P.PROPOSAL_APPROVE,
    summary: `Proposal ${p.proposal_no}, ₱${p.rate_per_pallet_day}/pallet/day`, link: `/proposals/${id}`, requestedBy: actor.id });
  await audit(tx, actor, 'proposal.submit', 'proposal', id, p, after, ctx);
  return after;
}
export async function decideProposal(tx: Tx, actor: Actor, id: string, decision: 'approve' | 'reject', note: string | null, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PROPOSAL_APPROVE);
  const p = await lock(tx, 'proposals', id);
  if (p.status !== 'pending_approval') throw new AppError(`proposal is ${p.status}`, 409);
  assertNotSelf(actor, p.created_by);
  if (decision === 'reject' && !note?.trim()) throw new AppError('a reason is required to reject', 422);
  const after = decision === 'approve'
    ? await one(tx, `UPDATE proposals SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *`, [id, actor.id])
    : await one(tx, `UPDATE proposals SET status='draft' WHERE id=$1 RETURNING *`, [id]);
  await closeApproval(tx, actor, 'proposal', id, decision === 'approve' ? 'approved' : 'rejected', note);
  await audit(tx, actor, `proposal.${decision}`, 'proposal', id, p, after, ctx);
  return after;
}
registerDecisionHandler('proposal', (tx, a, id, d, n, c) => decideProposal(tx, a, id, d, n, c).then(() => {}));

export async function sendProposal(tx: Tx, actor: Actor, id: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.PROPOSAL_SEND);
  const p = await lock(tx, 'proposals', id);
  if (p.status !== 'approved') throw new AppError('only an approved proposal can be sent', 409);
  const after = await one(tx, `UPDATE proposals SET status='sent', sent_at=now() WHERE id=$1 RETURNING *`, [id]);
  await audit(tx, actor, 'proposal.send', 'proposal', id, p, after, ctx);     // email delivery is logged here (§5 M2)
  return after;
}

/**
 * Record the signed conforme (§5 M2). BR-10: an expired proposal cannot be converted without re-approval.
 * BR-28: creates the 'proposal' rate term for the site from the conforme date, so a delivery before the contract is priced.
 */
export async function recordConforme(tx: Tx, actor: Actor, id: string, input: { signedOn: string; fileId: string; siteId?: string }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.CONTRACT_WRITE);
  const p = await lock(tx, 'proposals', id);
  if (!['approved', 'sent'].includes(p.status)) throw new AppError(`proposal is ${p.status}`, 409);
  if (input.signedOn > p.valid_until) throw new RuleViolation('BR-10', `proposal expired on ${p.valid_until}; re-approval needed`);
  const siteId = input.siteId ?? p.site_id;
  if (!siteId) throw new AppError('which site is this conforme for?', 422);
  await assertSiteOfClient(tx, siteId, p.client_id);
  const after = await one(tx, `UPDATE proposals SET status='conforme_signed', conforme_signed_on=$2, conforme_file_id=$3, site_id=$4 WHERE id=$1 RETURNING *`,
    [id, input.signedOn, input.fileId, siteId]);
  const term = await one(tx,
    `INSERT INTO site_rate_terms (site_id, source_type, proposal_id, rate_per_pallet_day, effective_from, created_by)
     VALUES ($1,'proposal',$2,$3,$4,$5) RETURNING *`, [siteId, id, p.rate_per_pallet_day, input.signedOn, actor.id]);
  await audit(tx, actor, 'proposal.conforme', 'proposal', id, p, { ...after, rate_term_id: term.id }, ctx);
  return { proposal: after, rateTerm: term };
}

/** Expire proposals past validity (job). */
export async function expireProposals(tx: Tx, today: string) {
  return many(tx, `UPDATE proposals SET status='expired' WHERE status IN ('draft','pending_approval','approved','sent') AND valid_until < $1 RETURNING id`, [today]);
}

// ---- contracts -----------------------------------------------------------------------------------------------
export async function createContractFromProposal(tx: Tx, actor: Actor, proposalId: string, input: { startDate: string; endDate?: string; siteIds?: string[] }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.CONTRACT_WRITE);
  const p = await lock(tx, 'proposals', proposalId);
  if (p.status !== 'conforme_signed') throw new AppError('a contract is generated from a proposal with a signed conforme', 409);
  const end = input.endDate ?? (await one<{ d: string }>(tx, `SELECT (($1::date + make_interval(months => $2))::date - 1)::text AS d`, [input.startDate, p.contract_months])).d;
  const c = await one(tx,
    `INSERT INTO contracts (client_id, proposal_id, rate_per_pallet_day, min_qty, delivery_mode, damage_rates, start_date, end_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [p.client_id, p.id, p.rate_per_pallet_day, p.min_qty, p.delivery_mode, JSON.stringify(p.damage_rates), input.startDate, end, actor.id]);
  for (const s of input.siteIds ?? (p.site_id ? [p.site_id] : [])) {
    await assertSiteOfClient(tx, s, p.client_id);
    await tx.query('INSERT INTO contract_sites (contract_id, site_id) VALUES ($1,$2)', [c.id, s]);
  }
  await audit(tx, actor, 'contract.create', 'contract', c.id, null, c, ctx);
  return c;
}

/**
 * Sign a contract (§7.3 lifecycle): end each site's proposal term the day before the contract start, or void it if the
 * contract starts the same day or earlier; then insert the contract term. The EXCLUDE constraint refuses any overlap.
 */
export async function signContract(tx: Tx, actor: Actor, contractId: string, input: { signedOn: string; fileId: string }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.CONTRACT_WRITE);
  const c = await lock(tx, 'contracts', contractId);
  if (!['draft', 'sent'].includes(c.status)) throw new AppError(`contract is ${c.status}`, 409);
  const sites = await many<{ site_id: string }>(tx, 'SELECT site_id FROM contract_sites WHERE contract_id=$1', [contractId]);
  if (!sites.length) throw new AppError('contract has no sites', 422);
  for (const { site_id } of sites) {
    const terms = await many<any>(tx, `SELECT * FROM site_rate_terms WHERE site_id=$1 AND status='active' AND source_type='proposal'
                                         AND (effective_to IS NULL OR effective_to >= $2) FOR UPDATE`, [site_id, c.start_date]);
    for (const t of terms) {
      if (t.effective_from >= c.start_date) await tx.query(`UPDATE site_rate_terms SET status='void' WHERE id=$1`, [t.id]);
      else await tx.query(`UPDATE site_rate_terms SET effective_to = ($2::date - 1) WHERE id=$1`, [t.id, c.start_date]);
    }
    await tx.query(`INSERT INTO site_rate_terms (site_id, source_type, contract_id, rate_per_pallet_day, effective_from, effective_to, created_by)
                    VALUES ($1,'contract',$2,$3,$4,$5,$6)`, [site_id, contractId, c.rate_per_pallet_day, c.start_date, c.end_date, actor.id]);
  }
  const after = await one(tx, `UPDATE contracts SET status='signed', signed_on=$2, signed_file_id=$3 WHERE id=$1 RETURNING *`, [contractId, input.signedOn, input.fileId]);
  await audit(tx, actor, 'contract.sign', 'contract', contractId, c, after, ctx);
  return after;
}

/** BR-10: a contract must be signed within 15 days after the first delivery. Returns the sites at risk (alert job). */
export async function contractsOverdueAfterFirstDelivery(tx: Tx, today: string) {
  return many(tx,
    `SELECT t.site_id, p.proposal_no, min((dr.received_at AT TIME ZONE 'Asia/Manila')::date) AS first_delivery
       FROM site_rate_terms t JOIN proposals p ON p.id = t.proposal_id
       JOIN delivery_receipts dr ON dr.site_id = t.site_id AND dr.status = 'received'
      WHERE t.source_type = 'proposal' AND t.status = 'active' AND t.effective_to IS NULL
      GROUP BY t.site_id, p.proposal_no
     HAVING min((dr.received_at AT TIME ZONE 'Asia/Manila')::date) + 15 < $1::date`, [today]);
}
/** §5 M2: renewal alerts at 90/60/30 days before end. */
export async function contractsExpiring(tx: Tx, today: string) {
  return many(tx, `SELECT *, (end_date - $1::date) AS days_left FROM contracts WHERE status='signed' AND end_date - $1::date IN (90, 60, 30)`, [today]);
}

// ---- sales orders --------------------------------------------------------------------------------------------
export const SoInput = z.object({
  orderType: z.enum(['deployment', 'dehire', 'pallet_audit', 'onsite_deployment']), clientId: z.string().uuid(), siteId: z.string().uuid(),
  proposalId: z.string().uuid().optional().nullable(), contractId: z.string().uuid().optional().nullable(),
  qty: z.number().int().positive(), minQtyOverrideReason: z.string().optional().nullable(), requestedDate: z.string(),
});

async function minQty(tx: Tx): Promise<number> {
  const s = await maybe<{ value: number }>(tx, `SELECT value FROM settings WHERE key='so.min_qty'`);
  return Number(s?.value ?? 240);
}

/** BR-01 checks shared by create and approve. */
async function checkSoRules(tx: Tx, so: { order_type: string; client_id: string; site_id: string; proposal_id: string | null; contract_id: string | null; requested_date: string; qty: number; min_qty_override_reason: string | null }) {
  const c = await one<any>(tx, 'SELECT status FROM clients WHERE id=$1', [so.client_id]);
  if (c.status !== 'accredited') throw new RuleViolation('BR-01', 'the client is not accredited');
  if (so.order_type !== 'pallet_audit') {
    const prop = so.proposal_id ? await maybe<any>(tx, 'SELECT status, client_id FROM proposals WHERE id=$1', [so.proposal_id]) : null;
    const con = so.contract_id ? await maybe<any>(tx, 'SELECT status, client_id FROM contracts WHERE id=$1', [so.contract_id]) : null;
    const ok = (prop && prop.status === 'conforme_signed' && prop.client_id === so.client_id) || (con && con.status === 'signed' && con.client_id === so.client_id);
    if (!ok) throw new RuleViolation('BR-01', 'needs a signed proposal conforme or a signed contract of this client');
    const term = await maybe(tx, `SELECT id FROM site_rate_terms WHERE site_id=$1 AND status='active'
                                    AND $2::date BETWEEN effective_from AND COALESCE(effective_to, 'infinity'::date)`, [so.site_id, so.requested_date]);
    if (!term) throw new RuleViolation('BR-01', `no active rate term covers ${so.requested_date} for this site`);
  }
  if (['deployment', 'onsite_deployment'].includes(so.order_type) && so.qty < (await minQty(tx)) && !so.min_qty_override_reason?.trim()) {
    throw new RuleViolation('BR-02', `minimum deployment order is ${await minQty(tx)} pallets; a lower quantity needs an override with a reason`);
  }
}

export async function createSalesOrder(tx: Tx, actor: Actor, input: z.input<typeof SoInput>, ctx: RequestCtx = {}) {
  requirePermission(actor, P.SO_CREATE);
  const s = SoInput.parse(input);
  const draft = { order_type: s.orderType, client_id: s.clientId, site_id: s.siteId, proposal_id: s.proposalId ?? null, contract_id: s.contractId ?? null,
    requested_date: s.requestedDate, qty: s.qty, min_qty_override_reason: s.minQtyOverrideReason ?? null };
  await checkSoRules(tx, draft);
  const row = await one(tx,
    `INSERT INTO sales_orders (order_type, client_id, site_id, proposal_id, contract_id, qty, min_qty_override_reason, requested_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [s.orderType, s.clientId, s.siteId, draft.proposal_id, draft.contract_id, s.qty, draft.min_qty_override_reason, s.requestedDate, actor.id]);
  await audit(tx, actor, 'so.create', 'sales_order', row.id, null, row, ctx);
  return row;
}
export async function submitSalesOrder(tx: Tx, actor: Actor, id: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.SO_CREATE);
  const so = await lock(tx, 'sales_orders', id);
  if (so.status !== 'draft') throw new AppError(`sales order is ${so.status}`, 409);
  const after = await one(tx, `UPDATE sales_orders SET status='submitted' WHERE id=$1 RETURNING *`, [id]);
  await requestApproval(tx, { entityType: 'sales_order', entityId: id, permission: P.SO_APPROVE,
    summary: `SO ${so.so_no}: ${so.qty} pallets (${so.order_type}) for ${so.requested_date}`, link: `/sales-orders/${id}`, requestedBy: actor.id });
  await audit(tx, actor, 'so.submit', 'sales_order', id, so, after, ctx);
  return after;
}
export async function decideSalesOrder(tx: Tx, actor: Actor, id: string, decision: 'approve' | 'reject', note: string | null, ctx: RequestCtx = {}) {
  requirePermission(actor, P.SO_APPROVE);
  const so = await lock(tx, 'sales_orders', id);
  if (so.status !== 'submitted') throw new AppError(`sales order is ${so.status}`, 409);
  assertNotSelf(actor, so.created_by);                                    // BR-21 (also a DB CHECK)
  if (decision === 'approve') {
    await checkSoRules(tx, so);
    if (so.min_qty_override_reason && !can(actor, P.SO_OVERRIDE_MIN)) throw new Forbidden(`missing ${P.SO_OVERRIDE_MIN}`);
  } else if (!note?.trim()) throw new AppError('a reason is required to reject', 422);
  const after = await one(tx, `UPDATE sales_orders SET status=$2, approved_by=CASE WHEN $2='approved' THEN $3::uuid END WHERE id=$1 RETURNING *`,
    [id, decision === 'approve' ? 'approved' : 'rejected', actor.id]);
  await closeApproval(tx, actor, 'sales_order', id, decision === 'approve' ? 'approved' : 'rejected', note);
  await audit(tx, actor, `so.${decision}`, 'sales_order', id, so, after, ctx);
  return after;
}
registerDecisionHandler('sales_order', (tx, a, id, d, n, c) => decideSalesOrder(tx, a, id, d, n, c).then(() => {}));

export async function cancelSalesOrder(tx: Tx, actor: Actor, id: string, reason: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.SO_CREATE);
  const so = await lock(tx, 'sales_orders', id);
  if (['fulfilled', 'cancelled', 'void', 'rejected'].includes(so.status)) throw new AppError(`sales order is ${so.status}`, 409);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  const after = await one(tx, `UPDATE sales_orders SET status='cancelled', void_reason=$2 WHERE id=$1 RETURNING *`, [id, reason]);
  await audit(tx, actor, 'so.cancel', 'sales_order', id, so, after, ctx);
  return after;
}
/** BR-13 / §6: void only by SALES_MGR, with a reason; the number is never reused. */
export async function voidSalesOrder(tx: Tx, actor: Actor, id: string, reason: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.SO_APPROVE);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  const so = await lock(tx, 'sales_orders', id);
  if (so.status === 'void') throw new AppError('already void', 409);
  const live = await maybe(tx, `SELECT 1 FROM delivery_receipts dr WHERE dr.sales_order_id=$1 AND dr.status <> 'void'`, [id]);
  if (live) throw new AppError('void the DRs of this order first', 409);
  const after = await one(tx, `UPDATE sales_orders SET status='void', void_reason=$2 WHERE id=$1 RETURNING *`, [id, reason]);
  await audit(tx, actor, 'so.void', 'sales_order', id, so, after, ctx);
  return after;
}
export async function listSalesOrders(tx: Tx, actor: Actor) {
  if (actor.roles.includes('CLIENT')) {
    requirePermission(actor, P.PORTAL_READ);
    return many(tx, `SELECT * FROM sales_orders WHERE client_id=$1 AND status NOT IN ('draft','void') ORDER BY created_at DESC`, [actor.clientScope ?? null]);
  }
  requirePermission(actor, P.SO_READ);
  return many(tx, 'SELECT * FROM sales_orders ORDER BY created_at DESC LIMIT 500');
}
