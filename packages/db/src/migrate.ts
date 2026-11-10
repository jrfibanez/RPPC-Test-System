// Numbered SQL migrations (CLAUDE.md rule 2). An applied migration may never change: its sha256 is recorded and checked.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../migrations');

export async function migrate(ownerUrl: string, log: (s: string) => void = () => {}): Promise<string[]> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query("SET TIME ZONE 'UTC'");
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await c.query('SELECT name, sha256 FROM schema_migrations')).rows.map((r) => [r.name, r.sha256]));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const ran: string[] = [];
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const sha = crypto.createHash('sha256').update(sql).digest('hex');
      const prev = applied.get(f);
      if (prev) {
        if (prev !== sha) throw new Error(`migration ${f} was edited after it was applied — add a new migration instead`);
        continue;
      }
      log(`applying ${f}`);
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1,$2)', [f, sha]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      ran.push(f);
    }
    return ran;
  } finally {
    await c.end();
  }
}
