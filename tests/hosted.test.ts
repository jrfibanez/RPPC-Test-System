// Hosting adaptations (0015): database file storage, RLS everywhere, Supabase-style API roles locked out.
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { freshDb, tx, makeUser } from './helpers';
import { files } from '../packages/db/src/index';

const db = await freshDb();

describe('STORAGE_DRIVER=db (Vercel has no writable disk)', () => {
  it('stores an upload in file_blobs and serves it back through a signed URL', async () => {
    process.env.STORAGE_DRIVER = 'db';
    try {
      const u = await makeUser(db.app, ['DRIVER']);
      const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)]);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const intent = files.createUploadIntent(u, { purpose: 'pod_photo', mime: 'image/jpeg', size: body.length, sha256 });
      const q = new URL(`http://x${intent.url}`).searchParams;
      const { fileId } = await tx(db.app, (t) => files.storeUpload(t, q, body));
      const n = (await db.app.query('SELECT count(*)::int AS n FROM file_blobs')).rows[0].n;
      expect(n).toBe(1);
      const url = await tx(db.app, (t) => files.downloadUrl(t, fileId));
      const back = await tx(db.app, (t) => files.readBlob(t, new URL(`http://x${url}`).searchParams));
      expect(back.body.equals(body)).toBe(true);
    } finally { delete process.env.STORAGE_DRIVER; }
  });
});

describe('row-level security on every table (§8.2 defense in depth)', () => {
  it('is enabled on all public tables, with app_user keeping full access', async () => {
    const off = (await db.owner.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity`)).rows;
    expect(off).toEqual([]);
    expect((await db.app.query('SELECT count(*)::int AS n FROM roles')).rows[0].n).toBe(18);
  });
  it('a role like Supabase anon, given a table grant, still reads nothing (RLS), and app_client sees no other tables', async () => {
    await db.owner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rppc_test_anon') THEN CREATE ROLE rppc_test_anon NOLOGIN; END IF; END $$`);
    await db.owner.query(`GRANT USAGE ON SCHEMA public TO rppc_test_anon; GRANT SELECT ON users TO rppc_test_anon; GRANT rppc_test_anon TO app_user`);
    const c = await db.app.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE rppc_test_anon');
      expect((await c.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
      await c.query('ROLLBACK');
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE app_client');
      await expect(c.query('SELECT * FROM users')).rejects.toThrow(/permission denied/);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });
});
