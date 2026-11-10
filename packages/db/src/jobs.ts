// Background jobs (§9): weekly payroll (system job, BR-16), approval reminders + digest (§5 M13), nightly audit-chain
// verification (§8.5), daily alerts (expiry, BR-10 15-day contract rule, BR-08 deadlines).
// Run by the pg-boss worker (scripts/worker.ts) on a server, or by Vercel Cron (/api/v1/cron/[job]) on Vercel.
import { lastCompletedPayWeek, manilaDate, isoDow, P } from '@rppc/core';
import { type Pool, withTx } from './pool';
import * as payroll from './domain/payroll';
import * as approvals from './domain/approvals';
import * as commercial from './domain/commercial';

export const JOBS: Record<string, { cron: string; run: (pool: Pool) => Promise<unknown> }> = {
  'weekly-payroll': { cron: '0 6 * * 6', run: (pool) => {             // Saturday 06:00 PHT, for the Sat–Fri week just ended
    const w = lastCompletedPayWeek(manilaDate(new Date()));
    return withTx(pool, async (tx) => {
      const p = await payroll.ensurePeriod(tx, w.start);
      return p.status === 'open' ? payroll.computePeriod(tx, p.id) : { skipped: `period is ${p.status}` };
    });
  } },
  'approval-reminders': { cron: '*/30 6-21 * * *', run: (pool) => withTx(pool, (tx) => approvals.runReminders(tx)) },
  'approval-digest': { cron: '30 7 * * *', run: (pool) => withTx(pool, async (tx) => {
    const rows = (await tx.query(`SELECT required_permission, count(*)::int AS n FROM approval_requests WHERE status='pending' GROUP BY 1`)).rows;
    for (const r of rows) for (const u of await approvals.holdersOf(tx, r.required_permission)) {
      await approvals.notify(tx, u, { kind: 'approval_digest', title: `${r.n} item(s) still waiting for approval`, link: '/', channels: ['in_app', 'email'] });
    }
    return rows;
  }) },
  'audit-chain-verify': { cron: '0 2 * * *', run: (pool) => withTx(pool, async (tx) => {
    const broken = (await tx.query('SELECT * FROM fn_verify_audit_chain()')).rows;
    if (broken.length) for (const u of await approvals.holdersOf(tx, P.AUDIT_READ)) {
      await approvals.notify(tx, u, { kind: 'security_audit_chain', title: 'Audit log integrity check FAILED', body: `first broken row id ${broken[0].broken_at}`, channels: ['in_app', 'email'] });
    }
    return { broken: broken.length };
  }) },
  'daily-alerts': { cron: '0 6 * * *', run: (pool) => withTx(pool, async (tx) => {
    const today = manilaDate(new Date());
    const expired = await commercial.expireProposals(tx, today);
    const expiring = await commercial.contractsExpiring(tx, today);
    const overdue = await commercial.contractsOverdueAfterFirstDelivery(tx, today);
    const deadlines = (await tx.query(`SELECT id, bs_no, dispute_deadline FROM billing_summaries WHERE status='invoiced' AND dispute_deadline = $1::date`, [today])).rows;
    const sales = await approvals.holdersOf(tx, P.CONTRACT_WRITE);
    for (const c of expiring) for (const u of sales) await approvals.notify(tx, u, { kind: 'contract_expiry', title: `Contract ${c.contract_no} ends in ${c.days_left} days`, channels: ['in_app', 'email'] });
    for (const o of overdue) for (const u of sales) await approvals.notify(tx, u, { kind: 'contract_overdue', title: `BR-10: contract not signed 15 days after first delivery (${o.proposal_no})`, channels: ['in_app', 'email'] });
    for (const d of deadlines) for (const u of await approvals.holdersOf(tx, P.BILL_WRITE)) await approvals.notify(tx, u, { kind: 'dispute_deadline', title: `Dispute window for ${d.bs_no} closes today`, link: `/billing`, channels: ['in_app'] });
    return { expired: expired.length, expiring: expiring.length, overdue: overdue.length, deadlines: deadlines.length };
  }) },
};

/**
 * One daily run for hosts that allow only a daily cron (Vercel Hobby): alerts, audit check, reminders + digest, and on
 * Saturdays (Manila) the weekly payroll. Each job runs in its own transaction; one failure does not stop the others.
 */
export async function runDaily(pool: Pool): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const names = ['daily-alerts', 'audit-chain-verify', 'approval-reminders', 'approval-digest'];
  if (isoDow(manilaDate(new Date())) === 6) names.push('weekly-payroll');
  for (const n of names) {
    try { out[n] = await JOBS[n].run(pool); } catch (e) { out[n] = { error: (e as Error).message }; }
  }
  return out;
}
