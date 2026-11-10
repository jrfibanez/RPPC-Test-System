# Changelog

## 0.1.0 — 2026-11-10 — Phase 0 foundation + Phase 1 order-to-delivery (+ Phase 2 payroll core)

Built from docs/SPEC.md v0.5. Migrations 0001–0011 are the spec SQL (§7.1–7.10, §10.1) **verbatim**.

### Added
- Auth (S0.3): argon2id passwords, TOTP + recovery codes, device-bound PIN, sessions (idle/absolute), lockout, per-IP limit, step-up, PIN re-entry, offboarding.
- RBAC (S0.4): catalog = §10.2; seed + §8.4 matrix generated and checked byte-for-byte against the spec; `route(perm)` wrapper; static route check.
- Audit log + numbering (S0.5), masters + CSV import (S0.6), signed-URL uploads with magic-byte/sha256 checks and a ClamAV hook (S0.7), approvals inbox + reminders (S0.8).
- Phase 1: proposals → conforme → rate terms → contracts; sales orders; work orders, trips with lines, vouchers (BR-23/27), DR + gate pass PDF with QR verify, gate check, driver PWA with offline idempotent sync, ledger postings (dispatch, delivery, shortfall, pickup, returns both modes, arrival), opening balances, reversals, billing summary (BR-06/07/08/28) + SAP CSV export with VAT.
- Phase 2 core: production encoding/approval, weekly payroll system job, four sign-offs, Owner approval, reopen, adjustments, payout.

### Fixes to the spec found while building (please fold into v0.6)
1. **Audit chain breaks under concurrency** (§7.1). `bigserial` id is drawn before the advisory lock, so ids and chain order can cross. Fixed in migration 0014 (id drawn inside the lock); regression test included.
2. **Returns could not post** (§10.8). Site stock carries the delivered condition (new/A); returns carry the checked class (B, C…), so the negative-stock trigger refused them. Posted as site → external (held condition) + external → destination (checked class) in one transaction; rent stops at the same instant.

### Open questions (decided provisionally — confirm)
- **Lost pallets keep accruing rent.** §10.8 says 'lost' lines are charged, not moved, so they stay on the site balance. Should a lost line also move site → external (stop rent)?
- Who maintains zones/trucks (used `settings.manage`, ADMIN_IT) and employees (used `users.manage`); §8.1 says HR also enrols devices but the catalog gives `users.manage` only to ADMIN_IT.
- `wo.approve` exists but no rule says a trip must wait for it — not enforced; used only for photo-flag FYIs.
- BR-19 (dehire before lock-in end needs OPS_MGR approval) — not yet enforced.
- Return trips: implemented as ticket + voucher + gate pass, no DR, empty truck at the gate.
- A client delivery fee for client pickups is ₱0 (not an RPPC delivery).

### Not done yet
Proposal/contract PDF templates and email sending; web push + email delivery (notifications are in-app only until VAPID/SMTP are configured); client portal UI; pallet audit, concerns, procurement modules; dashboards beyond the operations basics; HIBP breach-list integration (small offline list for now).
