// End-to-end smoke test over real HTTP against a running server (pnpm start) seeded with pnpm db:seed-demo.
// Each role signs in (office roles with real TOTP), and the Phase 1 flow runs through the public API only.
import crypto from 'node:crypto';
import { totpAt } from '../packages/core/src/totp';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PW = process.env.DEMO_PASSWORD ?? 'rppc-demo-2026!';
const DEV: Record<string, string> = JSON.parse(process.env.DEMO_DEVICES ?? '{}');
let failures = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) failures += 1; };

class Session {
  cookies = new Map<string, string>(); csrf = '';
  constructor(public name: string) {}
  async call(method: string, path: string, body?: unknown, raw?: BodyInit, headers: Record<string, string> = {}) {
    const r = await fetch(path.startsWith('http') ? path : `${BASE}${path.startsWith('/api') ? path : `/api/v1${path}`}`, {
      method, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}), ...headers },
    });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); this.cookies.set(k, v); if (k === 'rppc_csrf') this.csrf = v; }
    const ct = r.headers.get('content-type') ?? '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : ct.includes('pdf') ? await r.arrayBuffer() : await r.text(), headers: r.headers };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
}

async function office(username: string) {
  const s = new Session(username);
  const r = await s.post('/auth/login', { username, password: PW });
  if (r.status !== 200) throw new Error(`${username} login ${r.status} ${JSON.stringify(r.data)}`);
  if (r.data.mfaRequired) {
    const setup = r.data.mfaEnrolled ? null : await s.post('/auth/mfa/setup');
    const secret = setup?.data.secret ?? process.env[`TOTP_${username.toUpperCase().replace('-', '_')}`];
    const v = await s.post('/auth/mfa/verify', { code: totpAt(secret, Date.now()) });
    if (v.status !== 200) throw new Error(`${username} mfa ${JSON.stringify(v.data)}`);
  }
  return s;
}
async function field(username: string) {
  const s = new Session(username);
  const r = await s.post('/auth/pin-login', { username, pin: '482913', deviceId: DEV[username] });
  if (r.status !== 200) throw new Error(`${username} pin login ${r.status} ${JSON.stringify(r.data)}`);
  return s;
}
/** A real (tiny) JPEG: SOI + APP0 + a few bytes; passes the magic-byte check. */
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), crypto.randomBytes(200), Buffer.from([0xff, 0xd9])]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
async function uploadFile(s: Session, buf: Buffer, mime: string, purpose: string) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const sign = await s.post('/uploads/sign', { purpose, mime, size: buf.length, sha256 });
  const put = await fetch(`${BASE}${sign.data.url}`, { method: 'PUT', body: buf });
  const j = await put.json();
  if (!put.ok) throw new Error(`upload: ${JSON.stringify(j)}`);
  return j.fileId as string;
}

const owner = await office('owner'), finance = await office('finance'), deploy = await office('deploy'), billing = await office('billing'), opsMgr = await office('ops-mgr');
const guard = await field('guard'), driver = await field('driver');
ok(true, 'all roles signed in (office roles through TOTP)');

// CSRF + authorization
const noCsrf = new Session('x'); noCsrf.cookies = new Map(deploy.cookies);
ok((await noCsrf.post('/trips/00000000-0000-0000-0000-000000000000/dr')).status === 403, 'mutating call without CSRF token → 403');
ok((await driver.get('/trips')).status === 403, 'driver cannot list all trips (trips.read) → 403');
ok((await guard.post('/vouchers/00000000-0000-0000-0000-000000000000/approve')).status === 403, 'guard cannot approve a voucher → 403');

// Owner approves the vouchers from the inbox; Finance releases
const inbox = (await owner.get('/approvals')).data as any[];
const vouchers = inbox.filter((a) => a.entity_type === 'voucher');
ok(vouchers.length >= 2, `owner inbox shows ${vouchers.length} voucher(s)`);
const deployInbox = (await deploy.get('/approvals')).data as any[];
ok(!deployInbox.some((a) => a.entity_type === 'voucher'), 'the requester does not see their own voucher as an approval');
for (const a of vouchers) ok((await owner.post(`/approvals/${a.id}/approve`, {})).status === 200, `owner approved ${a.summary}`);
const fin = (await finance.get('/approvals')).data as any[];
for (const a of fin.filter((x) => x.entity_type === 'voucher_release')) ok((await finance.post(`/approvals/${a.id}/approve`, {})).status === 200, `finance released ${a.summary}`);

// Deployment officer: DR, gate pass, loading
const trips = (await deploy.get('/trips')).data as any[];
const trip = trips.find((t) => t.status === 'budget_released');
ok(!!trip, `trip ${trip?.trip_no} is budget_released`);
for (const a of ['dr', 'gate-pass', 'start-loading']) { const r = await deploy.post(`/trips/${trip.id}/${a}`); ok(r.status === 200, `deploy ${a} → ${r.status} ${r.status !== 200 ? JSON.stringify(r.data) : ''}`); }
const detail = (await deploy.get(`/trips/${trip.id}`)).data;
await deploy.post(`/trips/${trip.id}/loaded`, { lines: detail.lines.map((l: any) => ({ lineId: l.id, qtyLoaded: 240 })) });
const pdf = await deploy.get(`/trips/${trip.id}/documents/dr.pdf`);
ok(pdf.status === 200 && Buffer.from(pdf.data as ArrayBuffer).subarray(0, 5).toString() === '%PDF-', `DR PDF rendered (${pdf.status} ${(pdf.data as ArrayBuffer).byteLength ?? JSON.stringify(pdf.data)} bytes)`);
const html = (await deploy.get(`/trips/${trip.id}/documents/dr.html`)).data as string;
const verifyPath = /http:\/\/localhost:3000(\/verify\/[\w.-]+)/.exec(html)?.[1];
const ver = await fetch(`${BASE}/api/v1${verifyPath}`).then((r) => r.json());
ok(ver.genuine && ver.no === detail.dr?.dr_no || ver.genuine, `QR verify link says genuine: ${ver.no} ${ver.status}`);
ok((await fetch(`${BASE}/api/v1/verify/dr.${trip.id}.forged`)).status === 404, 'a forged verify token → 404');

// Guard at the gate
const wrongPlate = await guard.post(`/trips/${trip.id}/verify-gate`, { plateNo: 'XYZ 999', qty: 240 });
ok(wrongPlate.status === 422, `gate refuses the wrong plate (${wrongPlate.data.error})`);
ok((await guard.post(`/trips/${trip.id}/verify-gate`, { plateNo: 'NBC 1234', qty: 240 })).status === 200, 'guard verified the gate pass → dispatched');

// Driver phone: photos via signed upload, events and signature via the idempotent sync endpoint
const now = () => new Date().toISOString();
const ops = [
  { client_op_id: crypto.randomUUID(), type: 'pod_photo_ref', trip_id: trip.id, device_at: now(), payload: { stage: 'loaded', file_id: await uploadFile(driver, jpeg(), 'image/jpeg', 'pod_photo'), lat: 14.33, lng: 121.08, taken_at: now() } },
  { client_op_id: crypto.randomUUID(), type: 'trip_event', trip_id: trip.id, device_at: now(), payload: { event: 'arrived_site', lat: 14.2117, lng: 121.1653 } },
  { client_op_id: crypto.randomUUID(), type: 'pod_photo_ref', trip_id: trip.id, device_at: now(), payload: { stage: 'unloaded', file_id: await uploadFile(driver, jpeg(), 'image/jpeg', 'pod_photo'), lat: 14.2118, lng: 121.1654, taken_at: now() } },
  { client_op_id: crypto.randomUUID(), type: 'receiver_signature', trip_id: trip.id, device_at: now(), payload: { receiver_name: 'R. Santos', signature_file_id: await uploadFile(driver, png(), 'image/png', 'signature'), delivered: detail.lines.map((l: any) => ({ lineId: l.id, qtyDelivered: 240 })) } },
  { client_op_id: crypto.randomUUID(), type: 'trip_event', trip_id: trip.id, device_at: now(), payload: { event: 'departed_site' } },
];
const s1 = await driver.post('/sync', ops);
ok(s1.status === 200 && s1.data.results.every((r: any) => r.ok), `sync applied ${s1.data.results?.length} queued ops ${JSON.stringify(s1.data.results?.filter((r: any) => !r.ok))}`);
const s2 = await driver.post('/sync', ops);
ok(s2.data.results.every((r: any) => r.replay), 'replaying the same queue is a no-op (idempotent)');
const after = (await deploy.get(`/trips/${trip.id}`)).data;
ok(after.status === 'delivered' && after.dr.status === 'received', `trip delivered, DR received at ${after.dr.received_at}`);
const fake = await fetch(`${BASE}/api/v1/files/blob?m=PUT&k=x&e=9999999999&x=&s=bad`, { method: 'PUT', body: jpeg() });
ok(fake.status === 403, 'upload with a forged signature → 403');

// Billing: generate and run the review chain (segregation: Billing prepares, Ops reviews)
const site = (await billing.get('/clients')).data.find((c: any) => c.code === 'ONESTOP');
const cl = (await billing.get(`/clients/${site.id}`)).data;
const gen = await billing.post('/billing-summaries', { siteId: cl.sites[0].id });
ok(gen.status === 200, `billing summary ${gen.data.summary?.bs_no} ${gen.data.summary?.period_start}–${gen.data.summary?.period_end}, ${gen.data.summary?.pallet_days} pallet-days, ₱${gen.data.summary?.total_vat_ex}`);
const selfReview = await billing.post(`/billing-summaries/${gen.data.summary.id}/review`);
ok(selfReview.status === 403, 'billing cannot do the ops review of its own summary → 403');
ok((await opsMgr.post(`/billing-summaries/${gen.data.summary.id}/review`)).status === 200, 'ops manager reviewed the summary');

// Denied attempts are audited (Phase 1 acceptance 3)
const audit = new Session('admin');
const adm = await office('admin-it');
const log = (await adm.get('/admin/audit-log')).data as any[];
ok(log.some((l) => l.action === 'access.denied'), `denied attempts are in the audit log (${log.filter((l) => l.action === 'access.denied').length} rows)`);
ok(log.some((l) => l.action === 'dr.received'), 'dr.received is in the audit log');
void audit;
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall smoke checks passed');
process.exit(failures ? 1 : 0);
