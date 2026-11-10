// DEV ONLY: demo users for every role and a small dataset so the app can be clicked through end to end.
import { loadEnv } from './env';
loadEnv();
if (process.env.NODE_ENV === 'production') { console.error('refusing to seed demo data in production'); process.exit(1); }
const { getPool, withTx, auth, masters, commercial, trips, ledger, payroll } = await import('../packages/db/src/index');
const pool = getPool();
const PW = process.env.DEMO_PASSWORD ?? 'rppc-demo-2026!';
const PIN = '482913';
const exists = (await pool.query(`SELECT 1 FROM users WHERE username='owner'`)).rowCount;
if (exists) { console.log('demo data already present'); process.exit(0); }

const fileRow = async (by: string) => (await pool.query(`INSERT INTO files (storage_key, mime, size_bytes, sha256, scan_status, uploaded_by) VALUES ('demo/'||gen_random_uuid(),'application/pdf',1,'\\x00','clean',$1) RETURNING id`, [by])).rows[0].id as string;
const out: string[] = [];
const users: Record<string, any> = {};
await withTx(pool, async (tx) => {
  const office = ['OWNER', 'ADMIN_IT', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'BILLING', 'FINANCE', 'HR', 'SUPERVISOR'];
  for (const r of office) {
    const e = (await tx.query(`INSERT INTO employees (employee_no, full_name, pay_type) VALUES ($1,$2,'monthly') RETURNING id`, [`D-${r}`, `Demo ${r.replace('_', ' ').toLowerCase()}`])).rows[0].id;
    const id = await auth.createUser(tx, null, { username: r.toLowerCase().replace('_', '-'), fullName: `Demo ${r}`, roles: [r], password: PW, employeeId: e });
    users[r] = { id, roles: [r], employeeId: e, authMethod: 'password', mfaPassed: true, lastStepUpAt: new Date() };
    out.push(`${r.padEnd(11)} ${r.toLowerCase().replace('_', '-').padEnd(12)} password ${PW}`);
  }
  for (const r of ['GUARD', 'DRIVER', 'HELPER', 'WORKER']) {
    const e = (await tx.query(`INSERT INTO employees (employee_no, full_name, pay_type) VALUES ($1,$2,$3) RETURNING id`, [`D-${r}`, `Demo ${r.toLowerCase()}`, r === 'WORKER' ? 'piece_rate' : 'trip'])).rows[0].id;
    const id = await auth.createUser(tx, null, { username: r.toLowerCase(), fullName: `Demo ${r}`, roles: [r], pin: PIN, employeeId: e });
    const dev = await auth.enrollDevice(tx, users.ADMIN_IT, id, `${r} demo phone`);
    users[r] = { id, roles: [r], employeeId: e, authMethod: 'pin', mfaPassed: true, lastPinReentryAt: new Date() };
    out.push(`${r.padEnd(11)} ${r.toLowerCase().padEnd(12)} PIN ${PIN}  device ${dev}`);
  }
});
const U = users;
await withTx(pool, async (tx) => {
  const zone = await masters.createZone(tx, U.ADMIN_IT, { name: 'Laguna / Calabarzon', region: 'Luzon', kmFromPlant: 25 });
  await masters.setZoneRate(tx, U.OWNER, zone.id, '3500.00', String(masters.tripCostEstimate(25, 0.35, 62, 400)), '2026-01-01');
  await masters.createTruck(tx, U.ADMIN_IT, 'NBC 1234', 240); await masters.createTruck(tx, U.ADMIN_IT, 'NDF 5678', 240);
  const c = await masters.createClient(tx, U.SALES, { code: 'ONESTOP', legalName: 'Onestop Warehousing Inc.', tin: '000-000-000-000' });
  const s = await masters.createSite(tx, U.SALES, c.id, { name: 'Calamba DC', address: 'Calamba, Laguna', region: 'Luzon', zoneId: zone.id, lat: 14.2117, lng: 121.1653 });
  await masters.accreditClient(tx, U.SALES_MGR, c.id, await fileRow(U.SALES_MGR.id));
  const dm = await masters.createClient(tx, U.SALES, { code: 'DELMONTE', legalName: 'Del Monte Philippines, Inc.' });
  await masters.setCutoff(tx, U.SALES, dm.id, 25, '2026-01-01', '§18 assumption 1: Del Monte on the 25th');
  const p = await commercial.createProposal(tx, U.SALES, { clientId: c.id, siteId: s.id, ratePerPalletDay: '0.85', validUntil: '2027-06-30', attentionTo: 'Warehouse Manager' });
  await commercial.submitProposal(tx, U.SALES, p.id); await commercial.decideProposal(tx, U.SALES_MGR, p.id, 'approve', null); await commercial.sendProposal(tx, U.SALES, p.id);
  await commercial.recordConforme(tx, U.SALES, p.id, { signedOn: '2026-11-01', fileId: await fileRow(U.SALES.id) });
  await ledger.receiveIntoPlant(tx, U.OPS_MGR, 5000, 'new', 'opening_balance', '2026-10-31T16:00:00Z');
  const so = await commercial.createSalesOrder(tx, U.SALES, { orderType: 'deployment', clientId: c.id, siteId: s.id, proposalId: p.id, qty: 480, requestedDate: '2026-11-12' });
  await commercial.submitSalesOrder(tx, U.SALES, so.id); await commercial.decideSalesOrder(tx, U.SALES_MGR, so.id, 'approve', null);
  const wo = await trips.createWorkOrder(tx, U.DEPLOY, so.id, { qty: 480, plannedDate: '2026-11-12' });
  const truck = (await tx.query(`SELECT id FROM trucks WHERE plate_no='NBC 1234'`)).rows[0].id;
  for (const n of [1, 2]) {
    const t = await trips.createTrip(tx, U.DEPLOY, wo.id, { truckId: truck, driverId: U.DRIVER.employeeId, helperIds: [U.HELPER.employeeId], lines: [{ condition: 'new', qty: 240 }] });
    await trips.requestVoucher(tx, U.DEPLOY, t.id, { voucherNo: `PCV-00${n}`, budgetAmount: '2600.00' });   // waits in the Owner's inbox
  }
  // Appendix B rates (verify before production use) and BR-17 trip pay.
  const rates: Array<[string, string, string, string]> = [['BNEP', 'BNEP fabrication', 'fabrication', '17.50'], ['REP-AB', 'ECR repair class A&B', 'repair', '15.00'],
    ['PAINT-BLUE', 'BNEP blue paint', 'painting', '10.00'], ['DIP-REP', 'ECR repair dipping', 'dipping', '2.00'], ['CHAMFER', 'Chamfering bottom board', 'chamfering', '3.00'],
    ['BAKLAS', 'Onsite baklas (dismantling)', 'dismantling', '20.00'], ['PLAINER', 'Plainer (daily)', 'planing', '600.00']];
  for (const [code, name, cat, rate] of rates) {
    const a = (await tx.query(`INSERT INTO production_activities (code, name, category, unit) VALUES ($1,$2,$3,$4) RETURNING id`, [code, name, cat, code === 'PLAINER' ? 'day' : 'pc'])).rows[0].id;
    await payroll.setActivityRate(tx, U.OWNER, { activityId: a, rate, effectiveFrom: '2026-01-01' });
  }
  await payroll.setTripPayRate(tx, U.OWNER, 'driver', '1000.00', '2026-01-01');
  await payroll.setTripPayRate(tx, U.OWNER, 'helper', '600.00', '2026-01-01');
});
console.log('Demo users (dev only):\n' + out.join('\n'));
console.log('\nOffice roles marked MFA in §8.1 (OWNER, ADMIN_IT, OPS_MGR, SALES_MGR, HR, BILLING, FINANCE) set up TOTP at first sign-in.');
await pool.end();
