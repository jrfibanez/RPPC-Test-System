import crypto from 'node:crypto';
import pg from 'pg';
import { afterAll } from 'vitest';
import { newPool, withTx, type Tx, type Pool } from '../packages/db/src/pool';
import type { Actor } from '../packages/core/src/guard';
import { createUser } from '../packages/db/src/domain/auth';

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://rppc:rppc_dev@localhost:5432/postgres';

/** A fresh database cloned from the migrated template, with an owner pool and an app_user pool. */
export async function freshDb() {
  const name = `rppcx_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE rppc_test_tmpl`);
  await admin.end();
  const base = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const owner = newPool(base, 4);
  const app = newPool(base.replace(/\/\/[^@]+@/, '//app_user:app_user_test@'), 12);
  afterAll(async () => {
    await owner.end(); await app.end();
    const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.end();
  });
  return { name, owner, app, url: base };
}

export const tx = <T>(pool: Pool, fn: (t: Tx) => Promise<T>) => withTx(pool, fn);

/** Build an Actor as a fully authenticated office session (MFA passed, fresh step-up). */
export function actorOf(u: { id: string; roles: string[]; employeeId?: string; clientScope?: string }, over: Partial<Actor> = {}): Actor {
  return { authMethod: 'password', mfaPassed: true, lastStepUpAt: new Date(), ...u, ...over };
}

let n = 0;
/** Create a user with given roles; returns an Actor for it. Field roles get a PIN account and a linked employee. */
export async function makeUser(pool: Pool, roles: string[], opts: { employee?: boolean; clientScope?: string; pin?: boolean } = {}) {
  n += 1;
  const k = n;
  const field = opts.pin ?? roles.every((r) => ['DRIVER', 'HELPER', 'GUARD', 'WORKER'].includes(r));
  return tx(pool, async (t) => {
    let employeeId: string | undefined;
    if (opts.employee || field) {
      employeeId = (await t.query(`INSERT INTO employees (employee_no, full_name, pay_type) VALUES ($1,$2,'piece_rate') RETURNING id`, [`E${k}-${crypto.randomBytes(3).toString('hex')}`, `${roles[0]} person ${k}`])).rows[0].id;
    }
    const id = await createUser(t, null, {
      username: `${roles[0].toLowerCase()}_${k}_${crypto.randomBytes(2).toString('hex')}`, fullName: `${roles.join('/')} ${k}`, roles,
      ...(field ? { pin: '482913' } : { password: 'correct horse battery staple' }), employeeId: employeeId ?? null,
      scope: opts.clientScope ? { type: 'client', id: opts.clientScope } : undefined,
    });
    return actorOf({ id, roles, employeeId, clientScope: opts.clientScope }, field ? { authMethod: 'pin', mfaPassed: true, lastStepUpAt: undefined, lastPinReentryAt: new Date() } : {});
  });
}

/** A clean file row (stands in for an uploaded, scanned document/photo/signature). */
export async function fakeFile(pool: Pool, by: string, mime = 'image/jpeg') {
  const r = await pool.query(`INSERT INTO files (storage_key, mime, size_bytes, sha256, scan_status, uploaded_by) VALUES ($1,$2,100,$3,'clean',$4) RETURNING id`,
    [`test/${crypto.randomUUID()}`, mime, crypto.randomBytes(32), by]);
  return r.rows[0].id as string;
}
