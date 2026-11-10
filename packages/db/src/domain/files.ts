// §8.5 files: private storage, short-lived signed URLs (≤5 min), MIME allow-list + magic bytes, size limits, sha256,
// antivirus scan before scan_status='clean'. Dev storage = local directory (stand-in for the private S3 bucket of §9).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { type Actor, AppError, NotFound, Forbidden } from '@rppc/core';
import { type Tx, one, maybe } from '../pool';
import { audit, type RequestCtx } from '../audit';

export type Purpose = 'pod_photo' | 'signature' | 'document' | 'image';
const LIMITS: Record<Purpose, { mimes: string[]; max: number }> = {
  pod_photo: { mimes: ['image/jpeg', 'image/png'], max: 2 * 1024 * 1024 },            // delivery photos ≤ 2 MB
  signature: { mimes: ['image/png', 'image/jpeg'], max: 2 * 1024 * 1024 },
  image: { mimes: ['image/jpeg', 'image/png'], max: 5 * 1024 * 1024 },                // other images ≤ 5 MB
  document: { mimes: ['application/pdf', 'image/jpeg', 'image/png'], max: 15 * 1024 * 1024 }, // PDF ≤ 15 MB
};
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};

function secret(): Buffer {
  const k = process.env.APP_ENCRYPTION_KEY;
  if (!k) throw new AppError('APP_ENCRYPTION_KEY is not configured', 500, 'config');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(k, 'base64'), Buffer.alloc(0), Buffer.from('rppc-file-urls'), 32));
}
const storageDir = () => path.resolve(process.env.STORAGE_DIR ?? './storage');

/** A signed, expiring capability for one storage key and one method. */
export function signUrl(method: 'PUT' | 'GET', key: string, ttlSec = 300, extra = ''): string {
  const exp = Math.floor(Date.now() / 1000) + Math.min(ttlSec, 300);
  const sig = crypto.createHmac('sha256', secret()).update(`${method}\n${key}\n${exp}\n${extra}`).digest('base64url');
  return `/api/v1/files/blob?m=${method}&k=${encodeURIComponent(key)}&e=${exp}&x=${encodeURIComponent(extra)}&s=${sig}`;
}
export function verifySignedUrl(q: URLSearchParams, method: 'PUT' | 'GET'): string {
  const key = q.get('k') ?? '', exp = Number(q.get('e')), extra = q.get('x') ?? '', sig = q.get('s') ?? '';
  if (q.get('m') !== method || !key || !exp || exp < Date.now() / 1000) throw new Forbidden('link expired');
  const want = crypto.createHmac('sha256', secret()).update(`${method}\n${key}\n${exp}\n${extra}`).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) throw new Forbidden('bad signature');
  return key;
}

/** Step 1: ask for a signed PUT URL. The storage key is random, never user-supplied. */
export function createUploadIntent(actor: Actor, input: { purpose: Purpose; mime: string; size: number; sha256: string; prefix?: string }) {
  const lim = LIMITS[input.purpose];
  if (!lim || !lim.mimes.includes(input.mime) || !(input.size > 0) || input.size > lim.max) throw new Forbidden('file not allowed');
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new AppError('sha256 must be hex', 422);
  const key = `${input.prefix ?? input.purpose}/${crypto.randomUUID()}`;
  const meta = `${actor.id}|${input.purpose}|${input.mime}|${input.size}|${input.sha256}`;
  return { key, url: signUrl('PUT', key, 300, meta) };
}

/** Step 2 + 3: receive the bytes for a signed key, verify size, hash and magic bytes, scan, then register the file row. */
export async function storeUpload(tx: Tx, q: URLSearchParams, body: Buffer, ctx: RequestCtx = {}): Promise<{ fileId: string; scanStatus: string }> {
  const key = verifySignedUrl(q, 'PUT');
  const [userId, purpose, mime, size, sha] = (q.get('x') ?? '').split('|');
  if (body.length !== Number(size)) throw new AppError('size mismatch', 422);
  if (crypto.createHash('sha256').update(body).digest('hex') !== sha) throw new AppError('hash mismatch', 422);
  if (!MAGIC[mime]?.(body)) throw new AppError('file content does not match its type', 422);
  if (!LIMITS[purpose as Purpose]) throw new AppError('bad purpose', 422);
  const exists = await maybe(tx, 'SELECT 1 FROM files WHERE storage_key=$1', [key]);
  if (exists) throw new AppError('already uploaded', 409);
  const dest = path.join(storageDir(), key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body, { flag: 'wx' });
  const scan = await scanBuffer(body);
  const row = await one<{ id: string }>(tx, `INSERT INTO files (storage_key, original_name, mime, size_bytes, sha256, scan_status, uploaded_by)
                                              VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [key, null, mime, body.length, Buffer.from(sha, 'hex'), scan, userId]);
  if (scan === 'infected') await fs.rm(dest, { force: true });
  await audit(tx, { id: userId, roles: [] }, 'file.upload', 'file', row.id, null, { purpose, mime, size: body.length, scan }, ctx);
  return { fileId: row.id, scanStatus: scan };
}

/** ClamAV INSTREAM when CLAMD_HOST is set; otherwise 'pending' (or 'clean' only when FILE_SCAN=dev-skip, for local dev). */
export async function scanBuffer(buf: Buffer): Promise<'clean' | 'infected' | 'pending'> {
  const host = process.env.CLAMD_HOST;
  if (!host) return process.env.FILE_SCAN === 'dev-skip' ? 'clean' : 'pending';
  return new Promise((resolve) => {
    const sock = net.connect(Number(process.env.CLAMD_PORT ?? 3310), host);
    let out = '';
    sock.setTimeout(15_000, () => { sock.destroy(); resolve('pending'); });
    sock.on('error', () => resolve('pending'));
    sock.on('data', (d) => { out += d.toString(); });
    sock.on('end', () => resolve(/FOUND/.test(out) ? 'infected' : /OK/.test(out) ? 'clean' : 'pending'));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024); const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length); sock.write(len); sock.write(chunk);
      }
      sock.write(Buffer.alloc(4)); sock.end();
    });
  });
}

/** Signed GET URL (≤5 min) after the caller has done its own permission check on the record that references the file. */
export async function downloadUrl(tx: Tx, fileId: string): Promise<string> {
  const f = await maybe<any>(tx, 'SELECT storage_key, scan_status FROM files WHERE id=$1', [fileId]);
  if (!f) throw new NotFound();
  if (f.scan_status !== 'clean') throw new Forbidden('file is not cleared by the virus scan');
  return signUrl('GET', f.storage_key, 300);
}
export async function readBlob(q: URLSearchParams): Promise<{ body: Buffer; key: string }> {
  const key = verifySignedUrl(q, 'GET');
  return { body: await fs.readFile(path.join(storageDir(), key)), key };
}
