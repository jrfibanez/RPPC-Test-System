// Billing period and money helpers (BR-06, BR-07, BR-08). The pallet-day query itself runs in SQL (§7.6).
import { addDays, parseDate, fmtDate, isoDow } from './time';

export interface CutoffSetting { cutoffDay: number; effectiveFrom: string }
export const DEFAULT_CUTOFF_DAY = 10;

/** Cutoff in force on a date = the row with the latest effective_from <= that date; 10 if there is none (§7.2). */
export function cutoffInForce(settings: CutoffSetting[], on: string): number {
  const applicable = settings.filter((s) => s.effectiveFrom <= on).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return applicable[0]?.cutoffDay ?? DEFAULT_CUTOFF_DAY;
}

/**
 * BR-07 / §18 assumption 1: a summary runs from the day after the previous cutoff through this cutoff.
 * The cutoff in force on the period's first day decides where it ends, so a cutoff change applies from the next period
 * and never to a summary already issued.
 */
export function billingPeriodFrom(start: string, settings: CutoffSetting[]): { start: string; end: string } {
  const c = cutoffInForce(settings, start);
  const d = parseDate(start);
  let end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), c));
  if (end < d) end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, c));
  return { start, end: fmtDate(end) };
}

/** Day after a given cutoff date = start of the next period. */
export const nextPeriodStart = (prevEnd: string) => addDays(prevEnd, 1);

/** BR-08: business days exclude Saturdays, Sundays and holidays. Mirrors SQL add_business_days(). */
export function addBusinessDays(from: string, days: number, holidays: Set<string>): string {
  let d = from; let n = 0;
  while (n < days) { d = addDays(d, 1); if (isoDow(d) < 6 && !holidays.has(d)) n += 1; }
  return d;
}

/** VAT 12% is computed only in exports; rates are stored VAT-exclusive (§11). Works in centavos to avoid float drift. */
export const VAT_RATE = 0.12;
export function vatOf(amountVatEx: string): { vat: string; gross: string } {
  const cents = toCents(amountVatEx);
  const vat = Math.round(cents * 12 / 100);
  return { vat: fromCents(vat), gross: fromCents(cents + vat) };
}
export function toCents(s: string): number {
  const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.');
  const v = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -v : v;
}
export function fromCents(c: number): string {
  const neg = c < 0; const a = Math.abs(c);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
