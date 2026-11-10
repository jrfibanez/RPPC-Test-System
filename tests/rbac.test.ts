// S0.4 / §19.4: one catalog → seed + matrix; the matrix holds for every role × permission; PIN sessions barred.
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, SENSITIVE, PIN_STEPUP, type Permission } from '../packages/core/src/rbac';
import { PERMISSION_LABELS } from '../packages/core/src/rbac-labels';
import { ROLES } from '../packages/core/src/roles';
import { generateSeedSql, generateMatrixMarkdown } from '../packages/core/src/rbac-gen';
import { requirePermission, can, assertNotSelf, type Actor } from '../packages/core/src/guard';
import { freshDb } from './helpers';

const spec = fs.readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
const seedFile = fs.readFileSync(new URL('../packages/db/migrations/0011_seed_rbac.sql', import.meta.url), 'utf8');

/** The §8.4 matrix as printed in the spec: permission code → set of role abbreviations holding it. */
function specMatrix(): Map<string, Set<string>> {
  const lines = spec.split('\n');
  const start = lines.findIndex((l) => l.startsWith('| Permission | Code |'));
  const head = lines[start].split('|').slice(1, -1).map((s) => s.trim());
  const out = new Map<string, Set<string>>();
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('|')) break;
    const cells = l.split('|').slice(1, -1).map((s) => s.trim());
    const code = cells[1].replace(/`/g, '');
    out.set(code, new Set(head.slice(2).filter((_, i) => cells[i + 2] === '✔')));
  }
  return out;
}

describe('generated copies equal the catalog (§10.2)', () => {
  it('the SQL seed migration is exactly what the generator produces', () => {
    expect(seedFile.split('\n').slice(1).join('\n')).toBe(generateSeedSql());
  });
  it('the §8.4 matrix in docs/SPEC.md is exactly what the generator produces', () => {
    const lines = spec.split('\n');
    const start = lines.findIndex((l) => l.startsWith('| Permission | Code |'));
    let end = start; while (lines[end + 1]?.startsWith('|')) end += 1;
    expect(lines.slice(start, end + 1).join('\n') + '\n').toBe(generateMatrixMarkdown());
  });
  it('every permission has exactly one label', () => {
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual(PERMISSIONS.map((p) => p.code).sort());
  });
});

describe('catalog invariants (§10.2 tests)', () => {
  it('ADMIN_IT holds no *.approve permission (admin ≠ approver)', () => {
    expect(ROLE_PERMISSIONS.ADMIN_IT.filter((p) => /approve/.test(p))).toEqual([]);
  });
  it('only OWNER holds rates.manage', () => {
    expect(Object.entries(ROLE_PERMISSIONS).filter(([, ps]) => ps.includes('rates.manage')).map(([r]) => r)).toEqual(['OWNER']);
  });
  it('payroll.compute has no human role (system job only)', () => {
    expect(Object.values(ROLE_PERMISSIONS).some((ps) => ps.includes('payroll.compute'))).toBe(false);
  });
  it('no role holds both a payroll.verify_* sign-off and payroll.payout', () => {
    for (const [r, ps] of Object.entries(ROLE_PERMISSIONS)) {
      expect(ps.some((p) => p.startsWith('payroll.verify_')) && ps.includes('payroll.payout'), r).toBe(false);
    }
  });
  it('HR can read production but cannot enter or approve it; drivers/helpers have no production permission', () => {
    expect(ROLE_PERMISSIONS.HR).toContain('production.read');
    expect(ROLE_PERMISSIONS.HR.filter((p) => /production\.(enter|approve)/.test(p))).toEqual([]);
    for (const r of ['DRIVER', 'HELPER']) expect(ROLE_PERMISSIONS[r].filter((p) => p.startsWith('production.'))).toEqual([]);
  });
});

describe('permission matrix (S0.4): every role × every permission', () => {
  const m = specMatrix();
  const abbr = Object.fromEntries(ROLES.map((r) => [r.code, r.abbr]));
  for (const role of ROLES) {
    it(`${role.code} holds exactly what §8.4 says`, () => {
      const actor: Actor = { id: 'u', roles: [role.code], authMethod: 'password', mfaPassed: true, lastStepUpAt: new Date() };
      for (const p of PERMISSIONS) {
        const expected = m.get(p.code)!.has(abbr[role.code]);
        expect(can(actor, p.code as Permission), `${role.code} ${p.code}`).toBe(expected);
        if (expected) expect(() => requirePermission(actor, p.code as Permission)).not.toThrow();
        else expect(() => requirePermission(actor, p.code as Permission)).toThrow(/missing/);
      }
    });
  }
  it('the database role_permissions table matches the catalog', async () => {
    const db = await freshDb();
    const rows = (await db.app.query(`SELECT r.code AS role, rp.permission_code AS p FROM role_permissions rp JOIN roles r ON r.id = rp.role_id`)).rows;
    const fromDb = rows.map((r) => `${r.role}:${r.p}`).sort();
    const fromCatalog = PERMISSIONS.flatMap((p) => p.roles.map((r) => `${r}:${p.code}`)).sort();
    expect(fromDb).toEqual(fromCatalog);
    const sens = (await db.app.query(`SELECT code, sensitivity FROM permissions`)).rows;
    for (const s of sens) expect(PERMISSIONS.find((p) => p.code === s.code)?.sensitivity).toBe(s.sensitivity);
  });
});

describe('PIN sessions (§8.1)', () => {
  const pinActor = (roles: string[], reentry?: Date): Actor => ({ id: 'u', roles, authMethod: 'pin', mfaPassed: true, lastPinReentryAt: reentry });
  it('a PIN session is rejected for every sensitive permission, even if the role held it', () => {
    for (const perm of SENSITIVE) {
      const everyRole = pinActor(ROLES.map((r) => r.code), new Date());
      // payroll.compute has no holder at all, so it is refused as 'missing' before the PIN rule is reached.
      expect(() => requirePermission(everyRole, perm), perm).toThrow(perm === 'payroll.compute' ? /missing/ : /not allowed on a PIN session/);
    }
  });
  it('the guard payroll duties need PIN re-entry within 5 minutes', () => {
    for (const perm of PIN_STEPUP) {
      expect(() => requirePermission(pinActor(['GUARD']), perm)).toThrow(/re-enter your PIN/);
      expect(() => requirePermission(pinActor(['GUARD'], new Date(Date.now() - 6 * 60_000)), perm)).toThrow(/re-enter your PIN/);
      expect(() => requirePermission(pinActor(['GUARD'], new Date(Date.now() - 4 * 60_000)), perm)).not.toThrow();
    }
  });
  it('normal field permissions work on a PIN session', () => {
    expect(() => requirePermission(pinActor(['DRIVER']), 'trips.own')).not.toThrow();
    expect(() => requirePermission(pinActor(['GUARD']), 'gatepass.verify')).not.toThrow();
  });
});

describe('MFA and step-up (§8.1)', () => {
  it('MFA roles are refused until TOTP is passed', () => {
    expect(() => requirePermission({ id: 'u', roles: ['FINANCE'], authMethod: 'password', mfaPassed: false }, 'billing.read')).toThrow(/mfa required/);
    expect(() => requirePermission({ id: 'u', roles: ['SALES'], authMethod: 'password', mfaPassed: false }, 'so.create')).not.toThrow();
  });
  it('step-up permissions need a fresh (≤10 min) re-authentication', () => {
    const owner = (d?: Date): Actor => ({ id: 'u', roles: ['OWNER'], authMethod: 'password', mfaPassed: true, lastStepUpAt: d });
    for (const p of ['payroll.owner_approve', 'rates.manage', 'admin.break_glass', 'payroll.reopen', 'exports.any'] as Permission[]) {
      expect(() => requirePermission(owner(new Date(Date.now() - 11 * 60_000)), p)).toThrow(/step-up/);
      expect(() => requirePermission(owner(new Date()), p)).not.toThrow();
    }
  });
});

describe('segregation of duties helper (BR-21)', () => {
  it('refuses when the actor is the creator or the payee', () => {
    const a: Actor = { id: 'u1', employeeId: 'e1', roles: ['SALES_MGR'], authMethod: 'password', mfaPassed: true };
    expect(() => assertNotSelf(a, 'u1')).toThrow(/segregation of duties/);
    expect(() => assertNotSelf(a, 'x', 'e1')).toThrow(/segregation of duties/);
    expect(() => assertNotSelf(a, 'x', null, undefined)).not.toThrow();
  });
});
