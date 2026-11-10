// §10.3 authorization guard and segregation-of-duties helper (framework-free; the Next.js route() wrapper is in apps/web).
import { ROLE_PERMISSIONS, SENSITIVE, PIN_STEPUP, P, type Permission } from './rbac';
import { MFA_ROLES } from './roles';
import { Forbidden } from './errors';

export { Forbidden };

export interface Actor {
  id: string; roles: string[]; employeeId?: string; clientScope?: string;
  authMethod: 'password' | 'pin';          // office users sign in with password + TOTP; field users with a device-bound PIN
  mfaPassed: boolean;
  lastStepUpAt?: Date;                     // password/TOTP re-entry (office)
  lastPinReentryAt?: Date;                 // PIN re-entry (field)
  sessionId?: string;
}

/** §8.1 Step-up: payroll approval, payroll reopen, rate changes, role changes, break-glass, exports. */
export const STEP_UP_PERMISSIONS = new Set<Permission>([
  P.PAY_OWNER_APPROVE, P.PAY_REOPEN, P.RATES_MANAGE, P.USERS_MANAGE, P.BREAK_GLASS,
  P.BILL_EXPORT, P.PAY_EXPORT, P.EXPORT_ANY,
]);

export function can(actor: Actor, perm: Permission): boolean {
  return actor.roles.some((r) => ROLE_PERMISSIONS[r]?.includes(perm));
}

const MINUTES = 60_000;
const fresh = (d: Date | undefined, min: number, now: number) => !!d && now - d.getTime() <= min * MINUTES;

export function requirePermission(actor: Actor, perm: Permission, opts: { stepUp?: boolean; now?: number } = {}): void {
  const now = opts.now ?? Date.now();
  if (!can(actor, perm)) throw new Forbidden(`missing ${perm}`);

  if (actor.authMethod === 'pin') {
    // A stolen phone + PIN must never reach money, approvals, exports, rates or user management (§8.1).
    if (SENSITIVE.has(perm)) throw new Forbidden(`${perm} is not allowed on a PIN session`);
    // The guard's two payroll duties are allowed on a PIN session only right after re-entering the PIN.
    if (PIN_STEPUP.has(perm) && !fresh(actor.lastPinReentryAt, 5, now)) throw new Forbidden('re-enter your PIN');
  } else {
    if (actor.roles.some((r) => MFA_ROLES.has(r)) && !actor.mfaPassed) throw new Forbidden('mfa required');
    if ((opts.stepUp || STEP_UP_PERMISSIONS.has(perm)) && !fresh(actor.lastStepUpAt, 10, now)) {
      throw new Forbidden('step-up required');
    }
  }
}

/** BR-21: the approver must not be the creator or the payee. */
export function assertNotSelf(actor: Actor, ...involved: Array<string | null | undefined>): void {
  if (involved.some((id) => id && (id === actor.id || id === actor.employeeId))) {
    throw new Forbidden('segregation of duties: you cannot approve your own record');
  }
}
