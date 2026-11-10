import { migrate } from './migrate';
const url = process.env.DATABASE_OWNER_URL;
if (!url) { console.error('DATABASE_OWNER_URL is not set'); process.exit(1); }
const ran = await migrate(url, (s) => console.log(s));
console.log(ran.length ? `applied ${ran.length} migration(s)` : 'database is up to date');
