// The 18 roles of spec §3 / §10.1. `requiresMfa` drives the MFA rule of §8.1; `field` roles may use PIN login.
export interface RoleDef { code: string; name: string; abbr: string; requiresMfa: boolean; field: boolean }

export const ROLES: RoleDef[] = [
  { code: 'OWNER', name: 'President & CEO', abbr: 'OWN', requiresMfa: true, field: false },
  { code: 'ADMIN_IT', name: 'IT & QA Officer', abbr: 'ADM', requiresMfa: true, field: false },
  { code: 'OPS_MGR', name: 'Pallet Operations Manager', abbr: 'OPM', requiresMfa: true, field: false },
  { code: 'SALES_MGR', name: 'Sales Manager', abbr: 'SLM', requiresMfa: true, field: false },
  { code: 'SALES', name: 'Sales', abbr: 'SLS', requiresMfa: false, field: false },
  { code: 'DEPLOY', name: 'Deployment Officer', abbr: 'DEP', requiresMfa: false, field: false },
  { code: 'AUDITOR', name: 'Pallet Auditor', abbr: 'AUD', requiresMfa: false, field: false },
  { code: 'CSR_REPAIR', name: 'CSR Repair', abbr: 'CSR', requiresMfa: false, field: false },
  { code: 'PURCHASING', name: 'Purchasing', abbr: 'PUR', requiresMfa: false, field: false },
  { code: 'HR', name: 'HR & QA', abbr: 'HR', requiresMfa: true, field: false },
  { code: 'BILLING', name: 'Billing', abbr: 'BIL', requiresMfa: true, field: false },
  { code: 'FINANCE', name: 'Finance', abbr: 'FIN', requiresMfa: true, field: false },
  { code: 'SUPERVISOR', name: 'Production Supervisor/QC', abbr: 'SUP', requiresMfa: false, field: false },
  { code: 'GUARD', name: 'Security Guard', abbr: 'GRD', requiresMfa: false, field: true },
  { code: 'DRIVER', name: 'Driver', abbr: 'DRV', requiresMfa: false, field: true },
  { code: 'HELPER', name: 'Helper', abbr: 'HLP', requiresMfa: false, field: true },
  { code: 'WORKER', name: 'Pallet Maker/Painter', abbr: 'WRK', requiresMfa: false, field: true },
  { code: 'CLIENT', name: 'Client Portal', abbr: 'CLI', requiresMfa: false, field: false },
];

export const MFA_ROLES = new Set(ROLES.filter((r) => r.requiresMfa).map((r) => r.code));
/** §8.1: "Office roles can never use PIN login." Only these roles may hold a PIN account. */
export const FIELD_ROLES = new Set(ROLES.filter((r) => r.field).map((r) => r.code));
