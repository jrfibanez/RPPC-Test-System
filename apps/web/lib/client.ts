'use client';
// Browser API helper: sends the CSRF token (from the rppc_csrf cookie) on mutating calls.
export function csrf(): string { return document.cookie.split('; ').find((c) => c.startsWith('rppc_csrf='))?.split('=')[1] ?? ''; }
export class ApiError extends Error { constructor(m: string, public status: number) { super(m); } }
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const r = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin',
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf() } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError((data as any)?.error ?? r.statusText, r.status);
  return data as T;
}
export const peso = (v: string | number | null | undefined) => v == null ? '—' : `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const when = (v: string | null | undefined) => v ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—';

/** Upload a file through the signed-URL flow; returns the file id. */
export async function upload(blob: Blob, purpose: 'pod_photo' | 'signature' | 'document' | 'image'): Promise<string> {
  const buf = await blob.arrayBuffer();
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const { url } = await api<{ url: string }>('/uploads/sign', { body: { purpose, mime: blob.type, size: buf.byteLength, sha256: sha } });
  const r = await fetch(url, { method: 'PUT', body: buf });
  const j = await r.json(); if (!r.ok) throw new ApiError(j.error ?? 'upload failed', r.status);
  return j.fileId;
}
