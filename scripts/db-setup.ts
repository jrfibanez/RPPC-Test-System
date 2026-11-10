// One-shot local setup: create the database, apply migrations, give app_user the password from DATABASE_URL (dev only).
import pg from 'pg';
import { loadEnv } from './env';
import { migrate } from '../packages/db/src/migrate';
loadEnv();
const ownerUrl = process.env.DATABASE_OWNER_URL, appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) { console.error('Set DATABASE_OWNER_URL and DATABASE_URL (see .env.example)'); process.exit(1); }
const dbName = new URL(ownerUrl).pathname.slice(1);
const admin = new pg.Client({ connectionString: ownerUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1') });
await admin.connect();
if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName])).rowCount) {
  await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`); console.log(`created database ${dbName}`);
}
await admin.end();
const ran = await migrate(ownerUrl, (s) => console.log(s));
console.log(ran.length ? `applied ${ran.length} migration(s)` : 'schema is up to date');
const appPw = decodeURIComponent(new URL(appUrl).password);
if (appPw) {
  const c = new pg.Client({ connectionString: ownerUrl }); await c.connect();
  await c.query(`ALTER ROLE app_user PASSWORD '${appPw.replace(/'/g, "''")}'`); await c.end();
  console.log('app_user password set from DATABASE_URL');
}
