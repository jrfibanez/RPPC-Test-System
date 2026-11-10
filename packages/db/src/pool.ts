import pg from 'pg';

// numeric -> string (never float for money, CLAUDE.md rule 4); int8 -> number for counts; date -> 'YYYY-MM-DD' string.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export type Tx = pg.PoolClient;
export type Pool = pg.Pool;

let shared: pg.Pool | undefined;
/** Runtime pool: connects as the least-privilege app_user (DATABASE_URL). */
export function getPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!shared) {
    shared = new pg.Pool({ connectionString: url, max: 10 });
    // Session time zone is UTC everywhere; business dates are derived explicitly in Asia/Manila.
    shared.on('connect', (c) => { void c.query("SET TIME ZONE 'UTC'"); });
  }
  return shared;
}
export function newPool(url: string, max = 10): pg.Pool {
  const p = new pg.Pool({ connectionString: url, max });
  p.on('connect', (c) => { void c.query("SET TIME ZONE 'UTC'"); });
  return p;
}

/** Run fn in one transaction. Every state change and its audit row commit together (CLAUDE.md rule 5). */
export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function one<T = any>(tx: Tx | pg.Pool, sql: string, params: unknown[] = []): Promise<T> {
  const r = await tx.query(sql, params);
  if (r.rowCount !== 1) throw new Error(`expected one row, got ${r.rowCount}`);
  return r.rows[0] as T;
}
export async function maybe<T = any>(tx: Tx | pg.Pool, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await tx.query(sql, params);
  return r.rows[0] as T | undefined;
}
export async function many<T = any>(tx: Tx | pg.Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query(sql, params)).rows as T[];
}
