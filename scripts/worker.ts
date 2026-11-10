// Background jobs (§9 pg-boss): weekly payroll (system job, BR-16), approval reminders + digest (§5 M13),
// nightly audit-chain verification (§8.5), daily alerts (expiry, BR-10 15-day contract rule, BR-08 deadlines).
import PgBoss from 'pg-boss';
import { loadEnv } from './env';
loadEnv();
const { getPool, withTx, payroll, approvals, commercial } = await import('../packages/db/src/index');
const { lastCompletedPayWeek, manilaDate, P } = await import('../packages/core/src/index');

const boss = new PgBoss({ connectionString: process.env.DATABASE_OWNER_URL!, schema: 'pgboss' });
boss.on('error', (e) => console.error(JSON.stringify({ level: 'error', job: 'pg-boss', message: e.message })));
await boss.start();
const pool = getPool();
const log = (job: string, info: unknown) => console.log(JSON.stringify({ level: 'info', job, at: new Date().toISOString(), info }));
const TZ = { tz: 'Asia/Manila' };

const jobs: Record<string, { cron: string; run: () => Promise<unknown> }> = {
  'weekly-payroll': { cron: '0 6 * * 6', run: async () => {            // Saturday 06:00 PHT, for the Sat–Fri week just ended
    const w = lastCompletedPayWeek(manilaDate(new Date()));
    return withTx(pool, async (tx) => {
      const p = await payroll.ensurePeriod(tx, w.start);
      return p.status === 'open' ? payroll.computePeriod(tx, p.id) : { skipped: `period is ${p.status}` };
    });
  } },
  'approval-reminders': { cron: '*/30 6-21 * * *', run: () => withTx(pool, (tx) => approvals.runReminders(tx)) },
  'approval-digest': { cron: '30 7 * * *', run: () => withTx(pool, async (tx) => {
    const rows = (await tx.query(`SELECT required_permission, count(*)::int AS n FROM approval_requests WHERE status='pending' GROUP BY 1`)).rows;
    for (const r of rows) for (const u of await approvals.holdersOf(tx, r.required_permission)) {
      await approvals.notify(tx, u, { kind: 'approval_digest', title: `${r.n} item(s) still waiting for approval`, link: '/', channels: ['in_app', 'email'] });
    }
    return rows;
  }) },
  'audit-chain-verify': { cron: '0 2 * * *', run: () => withTx(pool, async (tx) => {
    const broken = (await tx.query('SELECT * FROM fn_verify_audit_chain()')).rows;
    if (broken.length) for (const perm of [P.AUDIT_READ]) for (const u of await approvals.holdersOf(tx, perm)) {
      await approvals.notify(tx, u, { kind: 'security_audit_chain', title: 'Audit log integrity check FAILED', body: `first broken row id ${broken[0].broken_at}`, channels: ['in_app', 'email'] });
    }
    return { broken: broken.length };
  }) },
  'daily-alerts': { cron: '0 6 * * *', run: () => withTx(pool, async (tx) => {
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

for (const [name, j] of Object.entries(jobs)) {
  await boss.createQueue(name);
  await boss.schedule(name, j.cron, {}, TZ);
  await boss.work(name, async () => { const out = await j.run(); log(name, out); });
}
if (process.argv[2]) { const j = jobs[process.argv[2]]; if (!j) throw new Error('unknown job'); log(process.argv[2], await j.run()); await boss.stop(); await pool.end(); process.exit(0); }
log('worker', `scheduled: ${Object.keys(jobs).join(', ')} (Asia/Manila)`);
// Web push / email delivery of queued notifications needs VAPID keys and an SMTP relay; until configured, notifications
// are delivered in-app only (the inbox and bell read the notifications table).
