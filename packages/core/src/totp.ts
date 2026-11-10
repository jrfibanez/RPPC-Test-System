// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what Google Authenticator / Microsoft Authenticator expect. §8.1 MFA.
import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch); if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secretB32: string, timeMs: number, step = 30): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
/** Accepts the current step and one step either side (clock drift). */
export function verifyTotp(secretB32: string, code: string, timeMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (const d of [-1, 0, 1]) {
    const exp = Buffer.from(totpAt(secretB32, timeMs + d * 30_000));
    if (timingSafeEqual(exp, Buffer.from(code))) return true;
  }
  return false;
}
export function otpauthUrl(secretB32: string, account: string, issuer = 'RPPC'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}`;
}

/** AES-256-GCM for TOTP secrets at rest (§8.5). Layout: iv(12) | tag(16) | ciphertext. */
export function encryptSecret(plain: string, keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64'); if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes (base64)');
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function decryptSecret(blob: Buffer, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}
