// §5 M1 clients and sites; masters (zones, trucks, employees); holidays (M12); CSV import (S0.6).
import { z } from 'zod';
import { type Actor, P, requirePermission, AppError, NotFound } from '@rppc/core';
import { type Tx, one, maybe, many } from '../pool';
import { audit, type RequestCtx } from '../audit';

export const ClientInput = z.object({
  code: z.string().min(2).max(20), legalName: z.string().min(2), tradeName: z.string().optional().nullable(),
  tin: z.string().optional().nullable(), address: z.string().optional().nullable(),
  paymentTermsDays: z.number().int().min(0).max(180).default(30),
});
export async function createClient(tx: Tx, actor: Actor, input: z.input<typeof ClientInput>, ctx: RequestCtx = {}) {
  requirePermission(actor, P.CLIENT_WRITE);
  const c = ClientInput.parse(input);
  const row = await one(tx,
    `INSERT INTO clients (code, legal_name, trade_name, tin, address, payment_terms_days) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [c.code, c.legalName, c.tradeName ?? null, c.tin ?? null, c.address ?? null, c.paymentTermsDays]);
  await audit(tx, actor, 'client.create', 'client', row.id, null, row, ctx);
  return row;
}

/** Only SALES_MGR can accredit; accreditation needs a document upload (§5 M1). */
export async function accreditClient(tx: Tx, actor: Actor, clientId: string, fileId: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.CLIENT_ACCREDIT);
  const before = await maybe(tx, 'SELECT * FROM clients WHERE id=$1 FOR UPDATE', [clientId]);
  if (!before) throw new NotFound('client not found');
  const f = await maybe(tx, `SELECT id FROM files WHERE id=$1 AND scan_status='clean'`, [fileId]);
  if (!f) throw new AppError('accreditation document must be uploaded and virus-scanned', 422);
  const after = await one(tx, `UPDATE clients SET status='accredited', accredited_by=$2, accredited_at=now(), accreditation_file_id=$3
                               WHERE id=$1 RETURNING *`, [clientId, actor.id, fileId]);
  await audit(tx, actor, 'client.accredit', 'client', clientId, before, after, ctx);
  return after;
}
export async function suspendClient(tx: Tx, actor: Actor, clientId: string, reason: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.CLIENT_ACCREDIT);
  if (!reason?.trim()) throw new AppError('reason required', 422);
  const after = await one(tx, `UPDATE clients SET status='suspended' WHERE id=$1 RETURNING *`, [clientId]);
  await audit(tx, actor, 'client.suspend', 'client', clientId, null, { reason }, ctx);
  return after;
}

/** BR-07: cutoff per client, changeable any time, history kept; applies from `effectiveFrom` (the next period start). */
export async function setCutoff(tx: Tx, actor: Actor, clientId: string, cutoffDay: number, effectiveFrom: string, reason: string | null, ctx: RequestCtx = {}) {
  requirePermission(actor, P.CLIENT_WRITE);
  // Never to an issued summary: the new cutoff may not start inside or before a live summary of this client.
  const clash = await maybe(tx, `SELECT bs_no FROM billing_summaries WHERE client_id=$1 AND status <> 'void' AND period_end >= $2 LIMIT 1`, [clientId, effectiveFrom]);
  if (clash) throw new AppError(`BR-07: a cutoff change applies from the next period; summary ${clash.bs_no} already covers ${effectiveFrom}`, 422, 'rule_violation');
  const row = await one(tx, `INSERT INTO client_cutoff_settings (client_id, cutoff_day, effective_from, set_by, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [clientId, cutoffDay, effectiveFrom, actor.id, reason]);
  await audit(tx, actor, 'client.cutoff_set', 'client', clientId, null, row, ctx);
  return row;
}

export const SiteInput = z.object({
  name: z.string().min(1), address: z.string().min(1), region: z.enum(['Luzon', 'Visayas', 'Mindanao']).optional().nullable(),
  zoneId: z.string().uuid().optional().nullable(), lat: z.number().min(-90).max(90).optional().nullable(),
  lng: z.number().min(-180).max(180).optional().nullable(), geofenceM: z.number().int().positive().default(300),
  contactName: z.string().optional().nullable(), contactMobile: z.string().optional().nullable(),
});
export async function createSite(tx: Tx, actor: Actor, clientId: string, input: z.input<typeof SiteInput>, ctx: RequestCtx = {}) {
  requirePermission(actor, P.CLIENT_WRITE);
  const s = SiteInput.parse(input);
  const row = await one(tx,
    `INSERT INTO client_sites (client_id, name, address, region, zone_id, lat, lng, geofence_m, contact_name, contact_mobile)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [clientId, s.name, s.address, s.region ?? null, s.zoneId ?? null, s.lat ?? null, s.lng ?? null, s.geofenceM, s.contactName ?? null, s.contactMobile ?? null]);
  await audit(tx, actor, 'site.create', 'client_site', row.id, null, row, ctx);
  return row;
}

/** Scope (§8.2): CLIENT users only see their own client. */
export async function listClients(tx: Tx, actor: Actor) {
  if (actor.roles.includes('CLIENT')) {
    requirePermission(actor, P.PORTAL_READ);
    return many(tx, 'SELECT * FROM clients WHERE id = $1', [actor.clientScope ?? null]);
  }
  requirePermission(actor, P.CLIENT_READ);
  return many(tx, 'SELECT * FROM clients ORDER BY code');
}
export async function getClient(tx: Tx, actor: Actor, id: string) {
  if (actor.roles.includes('CLIENT')) {
    requirePermission(actor, P.PORTAL_READ);
    if (actor.clientScope !== id) throw new NotFound();
  } else requirePermission(actor, P.CLIENT_READ);
  const c = await maybe(tx, 'SELECT * FROM clients WHERE id=$1', [id]);
  if (!c) throw new NotFound();
  const sites = await many(tx, 'SELECT * FROM client_sites WHERE client_id=$1 ORDER BY name', [id]);
  return { ...c, sites };
}

// ---- masters maintained by ADMIN_IT (settings.manage) and the Owner (rates) --------------------------------
export async function createZone(tx: Tx, actor: Actor, z0: { name: string; region: 'Luzon' | 'Visayas' | 'Mindanao'; kmFromPlant?: number | null }, ctx: RequestCtx = {}) {
  requirePermission(actor, P.SETTINGS);
  const row = await one(tx, 'INSERT INTO delivery_zones (name, region, km_from_plant) VALUES ($1,$2,$3) RETURNING *', [z0.name, z0.region, z0.kmFromPlant ?? null]);
  await audit(tx, actor, 'zone.create', 'delivery_zone', row.id, null, row, ctx);
  return row;
}
/** Zone fee per trip: Owner only, effective-dated (§8.3 rates). */
export async function setZoneRate(tx: Tx, actor: Actor, zoneId: string, feePerTrip: string, estTripCost: string | null, effectiveFrom: string, ctx: RequestCtx = {}) {
  requirePermission(actor, P.RATES_MANAGE);
  await tx.query(`UPDATE zone_rates SET effective_to = ($2::date - 1) WHERE zone_id=$1 AND effective_to IS NULL AND effective_from < $2`, [zoneId, effectiveFrom]);
  const row = await one(tx, 'INSERT INTO zone_rates (zone_id, fee_per_trip, est_trip_cost, effective_from) VALUES ($1,$2,$3,$4) RETURNING *',
    [zoneId, feePerTrip, estTripCost, effectiveFrom]);
  await audit(tx, actor, 'zone_rate.set', 'zone_rate', row.id, null, row, ctx);
  return row;
}
/** Cost generator (§5 M4): km × diesel litres/km × price, round trip. Proposes the budget; it decides nothing. */
export function tripCostEstimate(km: number, litresPerKm: number, pricePerLitre: number, extras = 0): string {
  return (Math.round((km * 2 * litresPerKm * pricePerLitre + extras) * 100) / 100).toFixed(2);
}

export async function createTruck(tx: Tx, actor: Actor, plateNo: string, capacity = 240, ctx: RequestCtx = {}) {
  requirePermission(actor, P.SETTINGS);
  const row = await one(tx, 'INSERT INTO trucks (plate_no, capacity_pallets) VALUES ($1,$2) RETURNING *', [plateNo, capacity]);
  await audit(tx, actor, 'truck.create', 'truck', row.id, null, row, ctx);
  return row;
}

export const EmployeeInput = z.object({
  employeeNo: z.string().min(1), fullName: z.string().min(1), position: z.string().optional().nullable(),
  department: z.string().optional().nullable(), payType: z.enum(['monthly', 'daily', 'piece_rate', 'trip']).default('piece_rate'),
  mobile: z.string().optional().nullable(), hiredOn: z.string().optional().nullable(),
});
export async function createEmployee(tx: Tx, actor: Actor, input: z.input<typeof EmployeeInput>, ctx: RequestCtx = {}) {
  requirePermission(actor, P.USERS_MANAGE);
  const e = EmployeeInput.parse(input);
  const row = await one(tx,
    `INSERT INTO employees (employee_no, full_name, position, department, pay_type, mobile, hired_on) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [e.employeeNo, e.fullName, e.position ?? null, e.department ?? null, e.payType, e.mobile ?? null, e.hiredOn ?? null]);
  await audit(tx, actor, 'employee.create', 'employee', row.id, null, { employee_no: e.employeeNo, full_name: e.fullName }, ctx);
  return row;
}

export async function addHoliday(tx: Tx, actor: Actor, hdate: string, name: string, kind = 'national', ctx: RequestCtx = {}) {
  requirePermission(actor, P.SETTINGS);
  await tx.query('INSERT INTO holidays (hdate, name, kind) VALUES ($1,$2,$3) ON CONFLICT (hdate) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind', [hdate, name, kind]);
  await audit(tx, actor, 'holiday.set', 'holiday', null, null, { hdate, name, kind }, ctx);
}

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). Header row required. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let field = '', row: string[] = [], q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false; } else field += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i += 1; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** S0.6 CSV import (§14 step 1). All-or-nothing: one bad row fails the whole file with its line number. */
export async function importClientsCsv(tx: Tx, actor: Actor, csv: string, ctx: RequestCtx = {}) {
  const rows = parseCsv(csv); let n = 0;
  for (const [i, r] of rows.entries()) {
    try {
      const c = await createClient(tx, actor, { code: r.code, legalName: r.legal_name, tradeName: r.trade_name || null, tin: r.tin || null,
        address: r.address || null, paymentTermsDays: r.payment_terms_days ? Number(r.payment_terms_days) : 30 }, ctx);
      if (r.site_name) await createSite(tx, actor, c.id, { name: r.site_name, address: r.site_address || r.address || '-', region: (r.region || null) as any }, ctx);
      n += 1;
    } catch (e) { throw new AppError(`line ${i + 2}: ${(e as Error).message}`, 422, 'import_failed'); }
  }
  return { imported: n };
}
export async function importEmployeesCsv(tx: Tx, actor: Actor, csv: string, ctx: RequestCtx = {}) {
  const rows = parseCsv(csv); let n = 0;
  for (const [i, r] of rows.entries()) {
    try {
      await createEmployee(tx, actor, { employeeNo: r.employee_no, fullName: r.full_name, position: r.position || null, department: r.department || null,
        payType: (r.pay_type || 'piece_rate') as any, mobile: r.mobile || null, hiredOn: r.hired_on || null }, ctx);
      n += 1;
    } catch (e) { throw new AppError(`line ${i + 2}: ${(e as Error).message}`, 422, 'import_failed'); }
  }
  return { imported: n };
}
