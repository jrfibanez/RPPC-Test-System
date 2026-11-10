// Store UTC, display/compute business dates in Asia/Manila (UTC+8, no DST) — spec §7 conventions, §11.
export const MANILA_TZ = 'Asia/Manila';
const MANILA_OFFSET_MS = 8 * 3600_000;

/** ISO date (YYYY-MM-DD) of an instant, in Manila. */
export function manilaDate(d: Date): string {
  return new Date(d.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}
export function parseDate(s: string): Date { return new Date(`${s}T00:00:00Z`); }
export function fmtDate(d: Date): string { return d.toISOString().slice(0, 10); }
export function addDays(s: string, n: number): string {
  const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return fmtDate(d);
}
/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoDow(s: string): number { const w = parseDate(s).getUTCDay(); return w === 0 ? 7 : w; }
export function daysBetween(a: string, b: string): number { return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000); }
export function formatManila(d: Date): string {
  return new Intl.DateTimeFormat('en-PH', { timeZone: MANILA_TZ, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
