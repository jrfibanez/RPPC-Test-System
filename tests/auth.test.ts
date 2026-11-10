// S0.3 authentication (§8.1).
import { describe, it, expect } from 'vitest';
import { freshDb, tx, makeUser } from './helpers';
import { auth } from '../packages/db/src/index';
import { totpAt } from '../packages/core/src/totp';

const db = await freshDb();
const PW = 'correct horse battery staple';
const userRow = async (id: string) => (await db.app.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
const login = (u: string, p: string, ip = '10.0.0.1') => auth.txCommitOnFailure(db.app, (t) => auth.passwordLogin(t, u, p, { ip }));

describe('password + TOTP', () => {
  it('password policy: ≥12 chars and not on the breach list', () => {
    expect(() => auth.checkPasswordPolicy('short')).toThrow(/12 characters/);
    expect(() => auth.checkPasswordPolicy('password1234')).toThrow(/breach/);
    expect(() => auth.checkPasswordPolicy('a long passphrase of mine')).not.toThrow();
  });
  it('stores argon2id hashes with the OWASP parameters, never the password', async () => {
    const a = await makeUser(db.app, ['SALES']);
    const u = await userRow(a.id);
    expect(u.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(JSON.stringify(u)).not.toContain(PW);
  });
  it('a non-MFA role gets a usable session; the token is opaque and only its hash is stored', async () => {
    const a = await makeUser(db.app, ['SALES']);
    const { username } = await userRow(a.id);
    const s = await login(username, PW);
    expect(s.mfaRequired).toBe(false);
    expect(Buffer.from(s.token, 'base64url').length).toBe(32);
    const rows = (await db.app.query('SELECT token_hash FROM sessions WHERE user_id=$1', [a.id])).rows;
    expect(rows[0].token_hash.toString('hex')).not.toContain(Buffer.from(s.token).toString('hex'));
    const actor = await tx(db.app, (t) => auth.loadActor(t, s.token));
    expect(actor.roles).toEqual(['SALES']);
  });
  it('an MFA role must set up and pass TOTP; recovery codes are issued once', async () => {
    const a = await makeUser(db.app, ['FINANCE']);
    const { username } = await userRow(a.id);
    const s = await login(username, PW);
    expect(s.mfaRequired).toBe(true);
    let actor = await tx(db.app, (t) => auth.loadActor(t, s.token));
    expect(actor.mfaPassed).toBe(false);
    const { secret, otpauth } = await tx(db.app, (t) => auth.mfaSetup(t, a.id));
    expect(otpauth).toMatch(/^otpauth:\/\/totp\/RPPC:/);
    expect((await userRow(a.id)).mfa_secret_enc.toString()).not.toContain(secret);   // encrypted at rest
    await expect(auth.txCommitOnFailure(db.app, (t) => auth.mfaVerify(t, actor, '000000'))).rejects.toThrow(/invalid code/);
    const { recoveryCodes } = await tx(db.app, (t) => auth.mfaVerify(t, actor, totpAt(secret, Date.now())));
    expect(recoveryCodes).toHaveLength(8);
    actor = await tx(db.app, (t) => auth.loadActor(t, s.token));
    expect(actor.mfaPassed).toBe(true);
    // the failed attempt was committed to the audit log even though the call threw
    expect((await db.app.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='auth.mfa_failed' AND actor_id=$1`, [a.id])).rows[0].n).toBe(1);
  });
});

describe('brute force (§8.1)', () => {
  it('5 failures lock the account with exponential back-off; errors are generic; failures audited', async () => {
    const a = await makeUser(db.app, ['SALES']);
    const { username } = await userRow(a.id);
    for (let i = 0; i < 5; i += 1) await expect(login(username, 'wrong password here', `10.1.0.${i}`)).rejects.toThrow('invalid username or password');
    const u = await userRow(a.id);
    expect(u.failed_logins).toBe(5);
    expect(new Date(u.locked_until).getTime()).toBeGreaterThan(Date.now());
    await expect(login(username, PW, '10.1.0.9')).rejects.toThrow('invalid username or password');   // locked: same message
    await expect(login('nobody-at-all', PW)).rejects.toThrow('invalid username or password');
    expect((await db.app.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='auth.login_failed' AND actor_id=$1`, [a.id])).rows[0].n).toBe(6);
  });
  it('per-IP limit: 20 failures in 15 minutes block that IP', async () => {
    for (let i = 0; i < 20; i += 1) await expect(login(`ghost${i}`, 'x', '10.9.9.9')).rejects.toThrow();
    await expect(login('ghost', 'x', '10.9.9.9')).rejects.toThrow(/too many attempts/);
  });
});

describe('device-bound PIN (§8.1)', () => {
  it('needs the enrolled device; a revoked device kills its sessions', async () => {
    const admin = await makeUser(db.app, ['ADMIN_IT']);
    const d = await makeUser(db.app, ['DRIVER']);
    const { username } = await userRow(d.id);
    const dev = await tx(db.app, (t) => auth.enrollDevice(t, admin, d.id, 'Driver phone'));
    await expect(auth.txCommitOnFailure(db.app, (t) => auth.pinLogin(t, username, '482913', '00000000-0000-0000-0000-000000000000'))).rejects.toThrow(/invalid PIN or device/);
    const s = await auth.txCommitOnFailure(db.app, (t) => auth.pinLogin(t, username, '482913', dev));
    const actor = await tx(db.app, (t) => auth.loadActor(t, s.token));
    expect(actor.authMethod).toBe('pin');
    await tx(db.app, (t) => auth.revokeDevice(t, admin, dev));
    await expect(tx(db.app, (t) => auth.loadActor(t, s.token))).rejects.toThrow(/session expired/);
  });
  it('office roles can never use PIN login', async () => {
    await expect(tx(db.app, (t) => auth.createUser(t, null, { username: 'pinfin', fullName: 'x', roles: ['FINANCE'], pin: '482913' }))).rejects.toThrow(/office roles can never use PIN/);
  });
  it('weak PINs are refused', () => {
    for (const p of ['111111', '123456', '987654', '12345']) expect(() => auth.checkPinPolicy(p)).toThrow();
  });
});

describe('sessions (§8.1)', () => {
  it('office idle timeout is 30 minutes', async () => {
    const a = await makeUser(db.app, ['SALES']);
    const s = await login((await userRow(a.id)).username, PW);
    await db.app.query(`UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE user_id=$1`, [a.id]);
    await expect(tx(db.app, (t) => auth.loadActor(t, s.token))).rejects.toThrow(/timed out/);
  });
  it('changing the password revokes every session', async () => {
    const a = await makeUser(db.app, ['SALES']);
    const s = await login((await userRow(a.id)).username, PW);
    const actor = await tx(db.app, (t) => auth.loadActor(t, s.token));
    await tx(db.app, (t) => auth.changeSecret(t, actor, PW, 'a brand new passphrase'));
    await expect(tx(db.app, (t) => auth.loadActor(t, s.token))).rejects.toThrow(/session expired/);
  });
  it('offboarding disables the user and revokes sessions and devices in one action', async () => {
    const admin = await makeUser(db.app, ['ADMIN_IT']);
    const d = await makeUser(db.app, ['HELPER']);
    const dev = await tx(db.app, (t) => auth.enrollDevice(t, admin, d.id, 'phone'));
    const s = await auth.txCommitOnFailure(db.app, async (t) => auth.pinLogin(t, (await userRow(d.id)).username, '482913', dev));
    await tx(db.app, (t) => auth.disableEmployee(t, admin, d.employeeId!));
    await expect(tx(db.app, (t) => auth.loadActor(t, s.token))).rejects.toThrow();
    expect((await db.app.query('SELECT revoked_at FROM devices WHERE id=$1', [dev])).rows[0].revoked_at).not.toBeNull();
  });
});
