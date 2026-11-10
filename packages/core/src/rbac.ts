// GENERATED from the catalog in §10.2 — do not hand-edit the role lists; edit the catalog and regenerate (CI checks §8.4 and the seed match).
export const PERMISSIONS = [
  // clients & commercial
  { key: 'CLIENT_READ', code: 'clients.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING', 'FINANCE'] },
  { key: 'CLIENT_WRITE', code: 'clients.write', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  { key: 'CLIENT_ACCREDIT', code: 'clients.accredit', sensitivity: 'sensitive', roles: ['SALES_MGR'] },
  { key: 'PROPOSAL_READ', code: 'proposals.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'BILLING'] },
  { key: 'PROPOSAL_WRITE', code: 'proposals.write', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  { key: 'PROPOSAL_APPROVE', code: 'proposals.approve', sensitivity: 'sensitive', roles: ['SALES_MGR'] },
  { key: 'PROPOSAL_SEND', code: 'proposals.send', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  { key: 'CONTRACT_WRITE', code: 'contracts.write', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  // orders & delivery
  { key: 'SO_READ', code: 'so.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'BILLING', 'FINANCE'] },
  { key: 'SO_CREATE', code: 'so.create', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  { key: 'SO_APPROVE', code: 'so.approve', sensitivity: 'sensitive', roles: ['SALES_MGR'] },
  { key: 'SO_OVERRIDE_MIN', code: 'so.override_min_qty', sensitivity: 'sensitive', roles: ['OWNER', 'SALES_MGR'] },
  { key: 'TRIP_READ', code: 'trips.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING', 'FINANCE', 'GUARD'] },
  { key: 'WO_APPROVE', code: 'wo.approve', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'TRIP_WRITE', code: 'trips.write', sensitivity: 'normal', roles: ['OPS_MGR', 'DEPLOY'] },
  { key: 'VOUCHER_REQUEST', code: 'vouchers.request', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'DEPLOY'] },
  { key: 'TRIP_APPROVE_BUDGET', code: 'trips.approve_budget', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'TRIP_RELEASE_BUDGET', code: 'trips.release_budget', sensitivity: 'sensitive', roles: ['FINANCE'] },
  { key: 'TRIP_DISPATCH', code: 'trips.dispatch', sensitivity: 'normal', roles: ['DEPLOY'] },
  { key: 'TRIP_OWN', code: 'trips.own', sensitivity: 'normal', roles: ['DRIVER', 'HELPER'] },
  { key: 'DR_READ', code: 'dr.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING', 'FINANCE'] },
  { key: 'DR_ISSUE', code: 'dr.issue', sensitivity: 'normal', roles: ['DEPLOY'] },
  { key: 'DR_RECEIVE', code: 'dr.receive', sensitivity: 'normal', roles: ['DRIVER', 'HELPER', 'DEPLOY'] },
  { key: 'RETURN_RECORD', code: 'returns.record', sensitivity: 'normal', roles: ['OPS_MGR', 'DEPLOY', 'AUDITOR'] },
  { key: 'DR_VOID', code: 'dr.void', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'GATEPASS_VERIFY', code: 'gatepass.verify', sensitivity: 'normal', roles: ['GUARD'] },
  { key: 'POD_UPLOAD', code: 'pod.upload', sensitivity: 'normal', roles: ['DRIVER', 'HELPER', 'DEPLOY'] },
  // inventory, audit & billing
  { key: 'INV_READ', code: 'inventory.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING', 'FINANCE', 'GUARD'] },
  { key: 'INV_ADJUST', code: 'inventory.adjust', sensitivity: 'normal', roles: ['OPS_MGR', 'DEPLOY', 'AUDITOR'] },
  { key: 'INV_APPROVE', code: 'inventory.approve', sensitivity: 'sensitive', roles: ['OWNER', 'OPS_MGR'] },
  { key: 'AUDIT_WRITE', code: 'pallet_audit.write', sensitivity: 'normal', roles: ['AUDITOR'] },
  { key: 'AUDIT_APPROVE', code: 'pallet_audit.approve', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'BILL_READ', code: 'billing.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'BILLING', 'FINANCE'] },
  { key: 'BILL_WRITE', code: 'billing.write', sensitivity: 'normal', roles: ['BILLING'] },
  { key: 'BILL_REVIEW', code: 'billing.review', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'BILL_EXPORT', code: 'billing.export', sensitivity: 'sensitive', roles: ['BILLING', 'FINANCE'] },
  // production & payroll
  { key: 'PROD_READ', code: 'production.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'HR', 'SUPERVISOR', 'GUARD'] },
  { key: 'PROD_ENTER_OWN', code: 'production.enter_own', sensitivity: 'normal', roles: ['WORKER'] },
  { key: 'PROD_ENTER_FOR', code: 'production.enter_for_others', sensitivity: 'normal', roles: ['SUPERVISOR', 'GUARD'] },
  { key: 'PROD_APPROVE', code: 'production.approve', sensitivity: 'sensitive', roles: ['SUPERVISOR'] },
  { key: 'PAY_COMPUTE', code: 'payroll.compute', sensitivity: 'sensitive', roles: [] },
  { key: 'PAY_READ', code: 'payroll.read', sensitivity: 'normal', roles: ['OWNER', 'HR', 'FINANCE', 'SUPERVISOR', 'GUARD'] },
  { key: 'PAY_PROD_VERIFY', code: 'payroll.verify_production', sensitivity: 'sensitive', roles: ['SUPERVISOR'] },
  { key: 'PAY_SEC_VERIFY', code: 'payroll.verify_security', sensitivity: 'pin_stepup', roles: ['GUARD'] },
  { key: 'PAY_HR_VERIFY', code: 'payroll.hr_verify', sensitivity: 'sensitive', roles: ['HR'] },
  { key: 'PAY_FIN_CHECK', code: 'payroll.finance_check', sensitivity: 'sensitive', roles: ['FINANCE'] },
  { key: 'PAY_OWNER_APPROVE', code: 'payroll.owner_approve', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'PAY_PAYOUT', code: 'payroll.payout', sensitivity: 'sensitive', roles: ['HR'] },
  { key: 'PAY_WITNESS', code: 'payroll.witness_payout', sensitivity: 'pin_stepup', roles: ['GUARD'] },
  { key: 'PAY_ADJUST', code: 'payroll.adjust', sensitivity: 'sensitive', roles: ['HR'] },
  { key: 'PAY_ADJUST_APPROVE', code: 'payroll.adjust_approve', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'PAY_REOPEN', code: 'payroll.reopen', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'PAY_READ_OWN', code: 'payroll.read_own', sensitivity: 'normal', roles: ['DRIVER', 'HELPER', 'WORKER'] },
  { key: 'PAY_EXPORT', code: 'payroll.export', sensitivity: 'sensitive', roles: ['FINANCE'] },
  { key: 'RATES_READ', code: 'rates.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'DEPLOY', 'HR', 'FINANCE'] },
  { key: 'RATES_MANAGE', code: 'rates.manage', sensitivity: 'sensitive', roles: ['OWNER'] },
  // procurement, concerns, reports (Phase 2-3)
  { key: 'PO_WRITE', code: 'purchasing.write', sensitivity: 'normal', roles: ['PURCHASING'] },
  { key: 'PO_APPROVE', code: 'purchasing.approve', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'PO_APPROVE_HIGH', code: 'purchasing.approve_high', sensitivity: 'sensitive', roles: ['FINANCE'] },
  { key: 'CONCERN_WRITE', code: 'concerns.write', sensitivity: 'normal', roles: ['OWNER', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING'] },
  { key: 'REPORT_EXEC', code: 'reports.executive', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'FINANCE'] },
  { key: 'PORTAL_READ', code: 'portal.read', sensitivity: 'normal', roles: ['CLIENT'] },
  // admin
  { key: 'USERS_MANAGE', code: 'users.manage', sensitivity: 'sensitive', roles: ['ADMIN_IT'] },
  { key: 'SETTINGS', code: 'settings.manage', sensitivity: 'sensitive', roles: ['ADMIN_IT'] },
  { key: 'AUDIT_READ', code: 'auditlog.read', sensitivity: 'normal', roles: ['OWNER', 'ADMIN_IT'] },
  { key: 'EXPORT_ANY', code: 'exports.any', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'BREAK_GLASS', code: 'admin.break_glass', sensitivity: 'sensitive', roles: ['OWNER'] },
] as const;
export type Permission = (typeof PERMISSIONS)[number]['code'];
export const P = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.code])) as {
  [K in (typeof PERMISSIONS)[number] as K['key']]: K['code'];
};
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {};
for (const p of PERMISSIONS) for (const r of p.roles) (ROLE_PERMISSIONS[r] ??= []).push(p.code);
export const SENSITIVE = new Set<Permission>(PERMISSIONS.filter((p) => p.sensitivity === 'sensitive').map((p) => p.code));
export const PIN_STEPUP = new Set<Permission>(PERMISSIONS.filter((p) => p.sensitivity === 'pin_stepup').map((p) => p.code));
// Tests: ADMIN_IT holds no *.approve; only OWNER holds rates.manage; PAY_COMPUTE has no human role;
// no role holds both payroll.verify_* and payroll.payout; every code here appears in the seed and in §8.4.
