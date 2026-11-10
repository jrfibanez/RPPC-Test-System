import { describe, it, expect } from 'vitest';
import { billingPeriodFrom, cutoffInForce, addBusinessDays, vatOf, toCents, fromCents } from '../src/billing';
import { payWeekOf, lastCompletedPayWeek } from '../src/payroll';
import { totpAt, verifyTotp, base32Encode, encryptSecret, decryptSecret } from '../src/totp';
import { transitionsFor, transitionPermission, assertCanDispatch, assertPodComplete } from '../src/trip';
import { photoFlags, haversineM } from '../src/geo';
import { manilaDate } from '../src/time';

describe('BR-07 billing periods', () => {
  it('runs from the day after the previous cutoff through this cutoff (default 10th)', () => {
    expect(billingPeriodFrom('2026-11-11', [])).toEqual({ start: '2026-11-11', end: '2026-12-10' });
    expect(billingPeriodFrom('2026-11-05', [])).toEqual({ start: '2026-11-05', end: '2026-11-10' });
    expect(billingPeriodFrom('2026-12-11', [])).toEqual({ start: '2026-12-11', end: '2027-01-10' });
  });
  it('a per-client cutoff (Del Monte 25th) and a change that applies from the next period', () => {
    const s = [{ cutoffDay: 25, effectiveFrom: '2026-01-01' }];
    expect(billingPeriodFrom('2026-10-26', s)).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    const changed = [...s, { cutoffDay: 10, effectiveFrom: '2026-11-26' }];
    expect(cutoffInForce(changed, '2026-11-25')).toBe(25);
    expect(billingPeriodFrom('2026-11-26', changed)).toEqual({ start: '2026-11-26', end: '2026-12-10' });
  });
});
describe('BR-08 business days', () => {
  it('skips weekends and holidays', () => {
    expect(addBusinessDays('2026-11-13', 5, new Set())).toBe('2026-11-20');
    expect(addBusinessDays('2026-11-13', 5, new Set(['2026-11-16']))).toBe('2026-11-23');
    expect(addBusinessDays('2026-12-23', 5, new Set(['2026-12-24', '2026-12-25', '2026-12-30', '2026-12-31']))).toBe('2027-01-05');
  });
});
describe('BR-16 pay week Saturday–Friday', () => {
  it('maps any date to its Sat–Fri week', () => {
    expect(payWeekOf('2026-11-10')).toMatchObject({ start: '2026-11-07', end: '2026-11-13' });
    expect(payWeekOf('2026-11-07')).toMatchObject({ start: '2026-11-07', end: '2026-11-13' });
    expect(payWeekOf('2026-11-13')).toMatchObject({ start: '2026-11-07', end: '2026-11-13' });
    expect(lastCompletedPayWeek('2026-11-14')).toMatchObject({ start: '2026-11-07', end: '2026-11-13' });   // the Saturday job
  });
});
describe('money', () => {
  it('VAT 12% in centavos, no float drift', () => {
    expect(vatOf('8622.00')).toEqual({ vat: '1034.64', gross: '9656.64' });
    expect(vatOf('0.10')).toEqual({ vat: '0.01', gross: '0.11' });
    expect(fromCents(toCents('-12.05'))).toBe('-12.05');
  });
});
describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vector (SHA-1, T=59 → 287082)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpAt(secret, 1111111109_000)).toBe('081804');
    expect(verifyTotp(secret, totpAt(secret, Date.now()))).toBe(true);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
  });
  it('AES-256-GCM round-trip, tamper detected', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const blob = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(decryptSecret(blob, key)).toBe('JBSWY3DPEHPK3PXP');
    blob[blob.length - 1] ^= 1;
    expect(() => decryptSecret(blob, key)).toThrow();
  });
});
describe('§10.4 trip state machines', () => {
  it('delivery needs the voucher steps; pickup skips them (BR-26)', () => {
    expect(transitionPermission('delivery', 'planned', 'budget_approved')).toBe('trips.approve_budget');
    expect(() => transitionPermission('delivery', 'planned', 'loading')).toThrow();
    expect(transitionPermission('pickup', 'planned', 'loading')).toBe('trips.dispatch');
    expect(transitionPermission('pickup', 'dispatched', 'delivered')).toBe('dr.receive');
    expect(Object.keys(transitionsFor('pickup').budget_approved)).toEqual([]);
  });
  it('BR-03/BR-04 dispatch checks', () => {
    const base = { hasTicket: true, voucherRequired: true, voucherReleased: true, drIssued: true, gatePassIssued: true, truckCapacity: 240, lines: [{ palletTypeId: 'p', condition: 'new', qtyLoaded: 240 }] };
    expect(() => assertCanDispatch(base)).not.toThrow();
    expect(() => assertCanDispatch({ ...base, lines: [{ ...base.lines[0], qtyLoaded: 241 }] })).toThrow(/capacity/);
    expect(() => assertCanDispatch({ ...base, voucherReleased: false })).toThrow(/released voucher/);
    expect(() => assertCanDispatch({ ...base, voucherRequired: false, voucherReleased: false })).not.toThrow();
  });
  it('BR-20 proof of delivery; pickup needs no site time-in/out', () => {
    const ok = { loadedPhotos: 1, unloadedPhotos: 1, photosMissingGeoOrTime: 0, receiverName: 'x', hasSignature: true, timeIn: new Date(), timeOut: new Date() };
    expect(() => assertPodComplete(ok, 'delivery')).not.toThrow();
    expect(() => assertPodComplete({ ...ok, timeOut: undefined }, 'delivery')).toThrow(/time-out/);
    expect(() => assertPodComplete({ ...ok, unloadedPhotos: 0, timeIn: undefined, timeOut: undefined }, 'pickup')).not.toThrow();
  });
});
describe('BR-25 photo flags', () => {
  it('flags >300 m from site and >10 min clock skew', () => {
    expect(Math.round(haversineM(14.2117, 121.1653, 14.2144, 121.1653))).toBe(300);
    const site = { lat: 14.2117, lng: 121.1653, geofenceM: 300 };
    const now = new Date();
    expect(photoFlags({ lat: 14.2118, lng: 121.1654, takenAtDevice: now, serverNow: now, site })).toEqual([]);
    expect(photoFlags({ lat: 14.25, lng: 121.1653, takenAtDevice: new Date(now.getTime() - 11 * 60_000), serverNow: now, site }).sort()).toEqual(['clock_skew', 'outside_geofence']);
  });
});
describe('time', () => {
  it('Manila business date of a UTC instant', () => {
    expect(manilaDate(new Date('2026-11-09T16:30:00Z'))).toBe('2026-11-10');
    expect(manilaDate(new Date('2026-11-09T15:59:59Z'))).toBe('2026-11-09');
  });
});
