// Builds a migrated template database once per run; each test file clones it (fast, isolated).
import pg from 'pg';
import { migrate } from '../packages/db/src/migrate';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://rppc:rppc_dev@localhost:5432/postgres';
export const TEMPLATE = 'rppc_test_tmpl';

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [TEMPLATE]);
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE}`);
  await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  await migrate(ADMIN_URL.replace(/\/[^/]*$/, `/${TEMPLATE}`));
  await admin.query(`ALTER ROLE app_user PASSWORD 'app_user_test'`);
  // drop leftovers of earlier runs
  const old = await admin.query(`SELECT datname FROM pg_database WHERE datname LIKE 'rppcx\_%'`);
  for (const r of old.rows) await admin.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
  await admin.end();
}
