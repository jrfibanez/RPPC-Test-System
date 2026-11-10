// Long-running worker for a server/VPS deployment (§9 pg-boss). On Vercel, Vercel Cron calls /api/v1/cron/daily instead.
import PgBoss from 'pg-boss';
import { loadEnv } from './env';
loadEnv();
const { getPool, jobs } = await import('../packages/db/src/index');
const pool = getPool();
const log = (job: string, info: unknown) => console.log(JSON.stringify({ level: 'info', job, at: new Date().toISOString(), info }));

if (process.argv[2]) {                         // run one job now: pnpm job weekly-payroll
  const j = jobs.JOBS[process.argv[2]]; if (!j) throw new Error(`unknown job; one of ${Object.keys(jobs.JOBS).join(', ')}`);
  log(process.argv[2], await j.run(pool)); await pool.end(); process.exit(0);
}
const boss = new PgBoss({ connectionString: process.env.DATABASE_OWNER_URL!, schema: 'pgboss' });
boss.on('error', (e) => console.error(JSON.stringify({ level: 'error', job: 'pg-boss', message: e.message })));
await boss.start();
for (const [name, j] of Object.entries(jobs.JOBS)) {
  await boss.createQueue(name);
  await boss.schedule(name, j.cron, {}, { tz: 'Asia/Manila' });
  await boss.work(name, async () => { log(name, await j.run(pool)); });
}
log('worker', `scheduled: ${Object.keys(jobs.JOBS).join(', ')} (Asia/Manila)`);
// Web push / email delivery of queued notifications needs VAPID keys and an SMTP relay; until configured, notifications
// are delivered in-app only (the inbox reads the notifications table).
