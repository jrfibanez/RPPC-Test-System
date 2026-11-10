// §8.1 authentication: argon2id passwords + TOTP for office users; device-bound 6-digit PIN for field users.
import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  type Actor, Unauthorized, Forbidden, AppError, MFA_ROLES, FIELD_ROLES,
  newTotpSecret, verifyTotp, encryptSecret, decryptSecret, otpauthUrl, P, requirePermission,
} from '@rppc/core';
import { type Tx, type Pool, one, maybe, many, withTx } from '../pool';
import { audit, type RequestCtx } from '../audit';
import { COMMON_PASSWORDS } from './common-passwords';

// OWASP: argon2id, m = 19 MiB, t = 2, p = 1. Algorithm 2 = argon2id in @node-rs/argon2.
const ARGON = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const hashSecret = (s: string) => argonHash(s, ARGON);
export const verifySecret = (h: string, s: string) => argonVerify(h, s).catch(() => false);

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const SESSION_LIMITS = {
  password: { idleMs: 30 * MIN, absoluteMs: 12 * HOUR },
  pin: { idleMs: 12 * HOUR, absoluteMs: 30 * DAY },
} as const;
const LOCK_STEPS_MIN = [1, 5, 15, 60];          // 5th failure → 1 min, then 5, 15, 60 …
const IP_LIMIT = { failures: 20, windowMin: 15 };

/** §8.1: minimum 12 characters, breached-list check, no composition rules. */
export function checkPasswordPolicy(pw: string): void {
  if (pw.length < 12) throw new AppError('password must be at least 12 characters', 422, 'weak_password');
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) throw new AppError('this password appears in breach lists; choose another', 422, 'weak_password');
}
export function checkPinPolicy(pin: string): void {
  if (!/^\d{6}$/.test(pin)) throw new AppError('PIN must be 6 digits', 422, 'weak_pin');
  if (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    throw new AppError('PIN is too easy to guess', 422, 'weak_pin');
  }
}

export interface NewUser {
  username: string; fullName: string; email?: string | null; roles: string[];
  password?: string; pin?: string; employeeId?: string | null;
  scope?: { type: 'client' | 'site'; id: string };
}

/** Create a user (ADMIN_IT, users.manage). Field users get a PIN, office users a password. */
export async function createUser(tx: Tx, actor: Actor | null, u: NewUser, ctx: RequestCtx = {}): Promise<string> {
  if (actor) requirePermission(actor, P.USERS_MANAGE);
  const pinUser = u.pin !== undefined;
  if (pinUser) {
    if (u.roles.some((r) => !FIELD_ROLES.has(r))) throw new AppError('office roles can never use PIN login (§8.1)', 422);
    checkPinPolicy(u.pin!);
  } else {
    if (!u.password) throw new AppError('password required', 422);
    checkPasswordPolicy(u.password);
  }
  const h = await hashSecret(pinUser ? u.pin! : u.password!);
  const row = await one<{ id: string }>(tx,
    `INSERT INTO users (username, email, full_name, auth_method, password_hash, pin_hash, employee_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [u.username, u.email ?? null, u.fullName, pinUser ? 'pin' : 'password', pinUser ? null : h, pinUser ? h : null, u.employeeId ?? null]);
  for (const code of u.roles) {
    const r = await maybe<{ id: string }>(tx, 'SELECT id FROM roles WHERE code=$1', [code]);
    if (!r) throw new AppError(`unknown role ${code}`, 422);
    await tx.query('INSERT INTO user_roles (user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4)',
      [row.id, r.id, u.scope?.type ?? null, u.scope?.id ?? null]);
  }
  await audit(tx, actor, 'user.create', 'user', row.id, null, { username: u.username, roles: u.roles, auth: pinUser ? 'pin' : 'password' }, ctx);
  return row.id;
}

async function rolesOf(tx: Tx, userId: string): Promise<{ codes: string[]; clientScope?: string }> {
  const rows = await many<{ code: string; scope_type: string | null; scope_id: string | null }>(tx,
    `SELECT r.code, ur.scope_type, ur.scope_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [userId]);
  const clientScope = rows.find((r) => r.scope_type === 'client')?.scope_id ?? undefined;
  return { codes: rows.map((r) => r.code), clientScope };
}

async function ipBlocked(tx: Tx, ip: string | null | undefined): Promise<boolean> {
  if (!ip) return false;
  const r = await one<{ n: number }>(tx,
    `SELECT count(*)::int AS n FROM login_attempts WHERE ip = $1 AND NOT ok AND at > now() - make_interval(mins => $2)`,
    [ip, IP_LIMIT.windowMin]);
  return r.n >= IP_LIMIT.failures;
}

async function recordFailure(tx: Tx, user: { id: string; failed_logins: number } | undefined, username: string, ctx: RequestCtx) {
  await tx.query('INSERT INTO login_attempts (ip, username, ok) VALUES ($1,$2,false)', [ctx.ip ?? null, username]);
  if (user) {
    const n = user.failed_logins + 1;
    const step = n >= 5 ? LOCK_STEPS_MIN[Math.min(n - 5, LOCK_STEPS_MIN.length - 1)] : 0;
    await tx.query(`UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 > 0 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1`,
      [user.id, n, step]);
  }
  await audit(tx, user ? { id: user.id, roles: [] } : null, 'auth.login_failed', 'user', user?.id ?? null, null, { username }, ctx);
}

export interface SessionResult { token: string; csrf: string; userId: string; mfaRequired: boolean; mfaEnrolled: boolean; expiresAt: Date }

async function createSession(tx: Tx, userId: string, method: 'password' | 'pin', mfaPassed: boolean, deviceId: string | null, ctx: RequestCtx): Promise<SessionResult> {
  const token = crypto.randomBytes(32).toString('base64url');      // 256-bit opaque token
  const csrf = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_LIMITS[method].absoluteMs);
  // Rotate on login: earlier sessions of the same device are revoked.
  if (deviceId) await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL', [userId, deviceId]);
  await tx.query(
    `INSERT INTO sessions (user_id, token_hash, device_id, ip, user_agent, mfa_passed, expires_at, auth_method, csrf_hash,
                           last_step_up_at, last_pin_reentry_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $8 = 'password' AND $6 THEN now() END, CASE WHEN $8 = 'pin' THEN now() END)`,
    [userId, sha256(token), deviceId, ctx.ip ?? null, ctx.userAgent ?? null, mfaPassed, expiresAt, method, sha256(csrf)]);
  return { token, csrf, userId, mfaRequired: !mfaPassed, mfaEnrolled: false, expiresAt };
}

const GENERIC = 'invalid username or password';

/** An error whose transaction must still COMMIT (failure counters, lockout, audit rows), then be re-thrown. */
const committed = <E extends Error>(e: E): E => Object.assign(e, { commitTx: true });
/** Runs fn in a transaction; if fn throws a `committed` error the work so far is committed before re-throwing. */
export async function txCommitOnFailure<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let failure: Error | undefined;
  const out = await withTx(pool, async (tx) => {
    try { return await fn(tx); } catch (e) {
      if ((e as { commitTx?: boolean }).commitTx) { failure = e as Error; return undefined as T; }
      throw e;
    }
  });
  if (failure) throw failure;
  return out;
}

/** Office login. Returns a session; if the user's roles require MFA the session is not usable until TOTP is verified. */
export async function passwordLogin(tx: Tx, username: string, password: string, ctx: RequestCtx = {}): Promise<SessionResult> {
  if (await ipBlocked(tx, ctx.ip)) throw new AppError('too many attempts, try again later', 429, 'rate_limited');
  const u = await maybe<any>(tx, `SELECT * FROM users WHERE username = $1 OR email = $1`, [username]);
  if (!u || u.status !== 'active' || u.auth_method !== 'password' || (u.locked_until && new Date(u.locked_until) > new Date())) {
    if (u?.password_hash) await verifySecret(u.password_hash, password);    // keep timing similar
    await recordFailure(tx, u && u.auth_method === 'password' ? u : undefined, username, ctx);
    throw committed(new Unauthorized(GENERIC));
  }
  if (!(await verifySecret(u.password_hash, password))) { await recordFailure(tx, u, username, ctx); throw committed(new Unauthorized(GENERIC)); }
  const { codes } = await rolesOf(tx, u.id);
  const needsMfa = codes.some((r) => MFA_ROLES.has(r));
  await tx.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  await tx.query('INSERT INTO login_attempts (ip, username, ok) VALUES ($1,$2,true)', [ctx.ip ?? null, username]);
  const s = await createSession(tx, u.id, 'password', !needsMfa, null, ctx);
  s.mfaEnrolled = u.mfa_enabled;
  await audit(tx, { id: u.id, roles: codes }, 'auth.login', 'user', u.id, null, { method: 'password', mfa_pending: needsMfa }, ctx);
  return s;
}

/** Field login: 6-digit PIN + an enrolled, unrevoked device of that user. */
export async function pinLogin(tx: Tx, username: string, pin: string, deviceId: string, ctx: RequestCtx = {}): Promise<SessionResult> {
  if (await ipBlocked(tx, ctx.ip)) throw new AppError('too many attempts, try again later', 429, 'rate_limited');
  const u = await maybe<any>(tx, `SELECT * FROM users WHERE username = $1`, [username]);
  const dev = u && /^[0-9a-f-]{36}$/i.test(deviceId)
    ? await maybe(tx, 'SELECT id FROM devices WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [deviceId, u.id]) : undefined;
  const bad = !u || u.status !== 'active' || u.auth_method !== 'pin' || !dev || (u.locked_until && new Date(u.locked_until) > new Date());
  if (bad || !(await verifySecret(u.pin_hash, pin))) {
    await recordFailure(tx, u && u.auth_method === 'pin' ? u : undefined, username, ctx);
    throw committed(new Unauthorized('invalid PIN or device'));
  }
  const { codes } = await rolesOf(tx, u.id);
  if (codes.some((r) => !FIELD_ROLES.has(r))) throw new Forbidden('office roles can never use PIN login');
  await tx.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  const s = await createSession(tx, u.id, 'pin', true, deviceId, ctx);
  await audit(tx, { id: u.id, roles: codes }, 'auth.login', 'user', u.id, null, { method: 'pin', device_id: deviceId }, ctx);
  return s;
}

/** Resolve the cookie token to an Actor, enforcing idle and absolute timeouts. */
export async function loadActor(tx: Tx, token: string | undefined | null): Promise<Actor> {
  if (!token) throw new Unauthorized();
  const s = await maybe<any>(tx,
    `SELECT s.*, u.status AS user_status, u.employee_id FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`, [sha256(token)]);
  if (!s || s.revoked_at || s.user_status !== 'active' || new Date(s.expires_at) < new Date()) throw new Unauthorized('session expired');
  const lim = SESSION_LIMITS[s.auth_method as 'password' | 'pin'];
  if (Date.now() - new Date(s.last_seen_at).getTime() > lim.idleMs) {
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.id]);
    throw new Unauthorized('session timed out');
  }
  await tx.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.id]);
  const { codes, clientScope } = await rolesOf(tx, s.user_id);
  return {
    id: s.user_id, roles: codes, employeeId: s.employee_id ?? undefined, clientScope,
    authMethod: s.auth_method, mfaPassed: s.mfa_passed,
    lastStepUpAt: s.last_step_up_at ? new Date(s.last_step_up_at) : undefined,
    lastPinReentryAt: s.last_pin_reentry_at ? new Date(s.last_pin_reentry_at) : undefined,
    sessionId: s.id,
  };
}

/** Constant-time check of the per-session CSRF token sent in a header on mutating requests (§8.5). */
export async function checkCsrf(tx: Tx, sessionId: string, csrf: string | null | undefined): Promise<boolean> {
  if (!csrf) return false;
  const s = await maybe<{ csrf_hash: Buffer }>(tx, 'SELECT csrf_hash FROM sessions WHERE id=$1', [sessionId]);
  return !!s?.csrf_hash && crypto.timingSafeEqual(s.csrf_hash, sha256(csrf));
}

function encKey(): string {
  const k = process.env.APP_ENCRYPTION_KEY;
  if (!k) throw new AppError('APP_ENCRYPTION_KEY is not configured', 500, 'config');
  return k;
}

/** Start TOTP enrolment: returns the secret once (to show as a QR); stored encrypted, not yet enabled. */
export async function mfaSetup(tx: Tx, userId: string): Promise<{ secret: string; otpauth: string }> {
  const u = await one<any>(tx, 'SELECT username, mfa_enabled FROM users WHERE id=$1', [userId]);
  if (u.mfa_enabled) throw new Conflict409('MFA is already enabled; a reset needs ADMIN_IT + OWNER');
  const secret = newTotpSecret();
  await tx.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [userId, encryptSecret(secret, encKey())]);
  return { secret, otpauth: otpauthUrl(secret, u.username) };
}
class Conflict409 extends AppError { constructor(m: string) { super(m, 409, 'conflict'); } }

/** Verify a TOTP code for the session (first time also enables MFA and issues recovery codes). */
export async function mfaVerify(tx: Tx, actor: Actor, code: string, ctx: RequestCtx = {}): Promise<{ recoveryCodes?: string[] }> {
  const u = await one<any>(tx, 'SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id=$1', [actor.id]);
  if (!u.mfa_secret_enc) throw new AppError('MFA is not set up', 409, 'mfa_not_setup');
  let ok = verifyTotp(decryptSecret(u.mfa_secret_enc, encKey()), code);
  if (!ok && u.mfa_enabled) {
    // recovery code path
    const codes = await many<any>(tx, 'SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [actor.id]);
    for (const c of codes) if (await verifySecret(c.code_hash, code)) { await tx.query('UPDATE mfa_recovery_codes SET used_at=now() WHERE id=$1', [c.id]); ok = true; break; }
  }
  if (!ok) { await audit(tx, actor, 'auth.mfa_failed', 'user', actor.id, null, null, ctx); throw committed(new Unauthorized('invalid code')); }
  await tx.query('UPDATE sessions SET mfa_passed = true, last_step_up_at = now() WHERE id = $1', [actor.sessionId]);
  let recoveryCodes: string[] | undefined;
  if (!u.mfa_enabled) {
    await tx.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [actor.id]);
    recoveryCodes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    for (const rc of recoveryCodes) await tx.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [actor.id, await hashSecret(rc)]);
    await audit(tx, actor, 'auth.mfa_enabled', 'user', actor.id, null, null, ctx);
  }
  return { recoveryCodes };
}

/** Step-up (§8.1): re-enter password and, when MFA is enabled, a TOTP code. Valid for 10 minutes. */
export async function stepUp(tx: Tx, actor: Actor, password: string, code: string | undefined, ctx: RequestCtx = {}) {
  const u = await one<any>(tx, 'SELECT password_hash, mfa_enabled, mfa_secret_enc FROM users WHERE id=$1', [actor.id]);
  if (actor.authMethod !== 'password' || !(await verifySecret(u.password_hash, password))) throw new Unauthorized('re-authentication failed');
  if (u.mfa_enabled && !(code && verifyTotp(decryptSecret(u.mfa_secret_enc, encKey()), code))) throw new Unauthorized('re-authentication failed');
  await tx.query('UPDATE sessions SET last_step_up_at = now() WHERE id=$1', [actor.sessionId]);
  await audit(tx, actor, 'auth.step_up', 'user', actor.id, null, null, ctx);
}

/** PIN re-entry for the guard's two payroll duties (valid 5 minutes). */
export async function pinReentry(tx: Tx, actor: Actor, pin: string, ctx: RequestCtx = {}) {
  const u = await one<any>(tx, 'SELECT pin_hash FROM users WHERE id=$1', [actor.id]);
  if (actor.authMethod !== 'pin' || !(await verifySecret(u.pin_hash, pin))) throw new Unauthorized('invalid PIN');
  await tx.query('UPDATE sessions SET last_pin_reentry_at = now() WHERE id=$1', [actor.sessionId]);
  await audit(tx, actor, 'auth.pin_reentry', 'user', actor.id, null, null, ctx);
}

export async function logout(tx: Tx, actor: Actor, ctx: RequestCtx = {}) {
  await tx.query('UPDATE sessions SET revoked_at = now() WHERE id=$1', [actor.sessionId]);
  await audit(tx, actor, 'auth.logout', 'user', actor.id, null, null, ctx);
}

/** Enrol a phone for a PIN user (ADMIN_IT / HR per §8.1; the catalog gives users.manage to ADMIN_IT). */
export async function enrollDevice(tx: Tx, actor: Actor, userId: string, label: string, ctx: RequestCtx = {}): Promise<string> {
  requirePermission(actor, P.USERS_MANAGE);
  const u = await one<any>(tx, 'SELECT auth_method FROM users WHERE id=$1', [userId]);
  if (u.auth_method !== 'pin') throw new AppError('only PIN users enrol devices', 422);
  const d = await one<{ id: string }>(tx, 'INSERT INTO devices (user_id, label, enrolled_by) VALUES ($1,$2,$3) RETURNING id', [userId, label, actor.id]);
  await audit(tx, actor, 'device.enroll', 'device', d.id, null, { user_id: userId, label }, ctx);
  return d.id;
}
export async function revokeDevice(tx: Tx, actor: Actor, deviceId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.USERS_MANAGE);
  await tx.query('UPDATE devices SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL', [deviceId]);
  await tx.query('UPDATE sessions SET revoked_at = now() WHERE device_id=$1 AND revoked_at IS NULL', [deviceId]);
  await audit(tx, actor, 'device.revoke', 'device', deviceId, null, null, ctx);
}

/** Offboarding (§8.1): disabling an employee disables the user and revokes sessions and devices in one action. */
export async function disableEmployee(tx: Tx, actor: Actor, employeeId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.USERS_MANAGE);
  await tx.query(`UPDATE employees SET status='inactive' WHERE id=$1`, [employeeId]);
  const users = await many<{ id: string }>(tx, `UPDATE users SET status='disabled' WHERE employee_id=$1 RETURNING id`, [employeeId]);
  for (const u of users) {
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL', [u.id]);
    await tx.query('UPDATE devices SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL', [u.id]);
  }
  await audit(tx, actor, 'employee.disable', 'employee', employeeId, null, { users: users.map((u) => u.id) }, ctx);
}

/** Change own password/PIN: revokes every session (§8.1). */
export async function changeSecret(tx: Tx, actor: Actor, current: string, next: string, ctx: RequestCtx = {}) {
  const u = await one<any>(tx, 'SELECT auth_method, password_hash, pin_hash FROM users WHERE id=$1', [actor.id]);
  const isPin = u.auth_method === 'pin';
  if (!(await verifySecret(isPin ? u.pin_hash : u.password_hash, current))) throw new Unauthorized('current secret is wrong');
  if (isPin) checkPinPolicy(next); else checkPasswordPolicy(next);
  const h = await hashSecret(next);
  await tx.query(`UPDATE users SET ${isPin ? 'pin_hash' : 'password_hash'} = $2 WHERE id=$1`, [actor.id, h]);
  await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL', [actor.id]);
  await audit(tx, actor, isPin ? 'auth.pin_changed' : 'auth.password_changed', 'user', actor.id, null, null, ctx);
}
