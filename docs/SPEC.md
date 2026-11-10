# RPPC One-Stop Operations System — Product & Technical Specification

| | |
|---|---|
| **Company** | Red Pallet Provider Co. (RPPC), S1 Group |
| **Version** | 0.5 — 2026-11-10 — review findings fixed (Appendix D); **ready for Claude Code** (remaining assumptions in §18) |
| **Owner** | President & CEO |
| **Status** | Review draft. Decisions and assumptions are in §18. Build instructions for Claude Code are in §19. |

---

## 0. Decisions already made (carried into this spec)

1. Web app (mobile-first PWA) for office and field users. No native app in v1.
2. **Phase 1 = order-to-delivery.** Production capture, payroll, CRM, purchasing follow in later phases.
3. App is **standalone**. Invoice printing (BIR format, Crystal Reports) and accounting stay in **SAP B1**. Hand-off is by **manual export (CSV/XLSX)**, no live integration.
4. Payroll inside the app is **piece-rate computation only**. Statutory deductions and payslips remain with HR/Finance.
5. Pallet makers' daily counts are **approved by a supervisor/QC** before they count.
6. Sales creates sales orders for **verified, accredited clients only**. Operations creates delivery work orders and DRs. Finance bills from an **operations-generated, client-approved billing summary**.
7. No truck tracking in the app.
8. Mobile onsite repair (repair fee matrix, repair billing) is deferred to Phase 3.
9. System-generated DRs are accepted (a company memorandum will say so). A Crystal Report–printed DR can be attached when a client needs it.
10. **Billing starts when pallets are delivered and the DR is signed and received at the client site.**
11. Driver and helper pay is a **flat amount per trip**, regardless of distance.
12. Weekly piece-rate payroll cuts off on **Friday** (pallet makers, painters, onsite pallet makers). Admin payroll (15th/30th) stays outside the app.
13. The existing Pallet Pooling System is parked until after the first round of changes to this system.
14. Drivers get **₱1,000** and helpers **₱600** per trip, paid in the same weekly run as the pallet makers. Payday is Saturday afternoon: cash is handed out by HR, assisted by Security.
15. Rent **stops** when the RPPC team receives the pallets back on site.
16. Every petty-cash voucher is **approved by the Owner**; the Finance head/cashier releases the cash.
17. Delivery photos: 1–2 per stage, small files, each with **GPS and timestamp**.
18. The billing cutoff is set **per client and can be changed at any time** (Del Monte on the 25th is assumed).
19. Weekly pay period is **Saturday–Friday**. The Production Officer, HR and Security each verify the quantities **and** check the payout in the weekly sign-off, together with Finance.
20. As today, workers hand a **paper output sheet** to Security, who verify and **encode** it (now into the app instead of Google Sheets/Excel). The Production Officer approves.
21. Pallets come back in two ways: RPPC collects them (often after an audit at the client site) or the client delivers them to the RPPC plant. The damage class is recorded where the check happens.
22. The system **notifies approvers** (in-app, push, email) whenever something waits for their approval.
23. *(v0.5)* Deliveries made on a signed proposal conforme **before the contract is signed are billed at the proposal rate**, through `site_rate_terms` (BR-28).
24. *(v0.5)* **Client pickups skip the voucher** and the crew trip pay; they still have trip ticket, DR and gate pass (BR-26).
25. *(v0.5)* The weekly payroll is computed by a **system job**, not by a person; HR proposes adjustments and the Owner approves them.
26. *(v0.5)* If the Owner raises a voucher himself it is auto-approved and flagged; Finance still releases it (BR-27).

### Changes in v0.2
Billing start moved from truck arrival to **signed DR received** (new `in_transit` step in the ledger); one DR per trip confirmed, with optional Crystal Report copy; trip pay is flat per trip; payroll now needs four sign-offs (Production Officer, Security on quantities only, HR, Finance) before Owner approval; pallet dynamic load fixed at 1,500 kg; BNEP, MRT and Growsari defined.

### Changes in v0.3
Rent now stops when the RPPC team receives pallets back on site (return receipt); trip pay fixed at ₱1,000/₱600 and merged into the weekly run; Saturday cash payout is recorded (HR distributes, Security witnesses); the Owner approves every voucher and Finance releases; photos need only 1–2 per stage but must carry GPS and a device timestamp (flagged when far from the site or the clock is off); client billing cutoff is changeable with history.

### Changes in v0.5
Fixed every finding from the Claude Code review (mapping in Appendix D) and the same class of problem elsewhere. **Billing:** pre-contract deliveries priced via new `site_rate_terms` (no overlaps possible); billing summaries can never overlap for a site; unpriced days block finalising. **Trips:** quantities moved to `trip_lines` (pallet type × condition); client pickups have their own no-voucher path; in-transit stock is tracked per trip. **Reissue:** voided documents and rejected entries can be re-created (partial unique indexes); wrong payroll lines are voided, not deleted. **Audit chain:** timestamps hashed as fixed UTC text via one shared function. **Security:** one permission catalog generates the code, the SQL seed and the §8.4 matrix; PIN sessions are technically barred from sensitive permissions; the app database role has its own RLS policy (§7.10). **Payroll:** computed by a system job, sign-offs tied to the frozen total and a round number, adjustments need Owner approval. **Smaller:** photo limit 2 MB everywhere, Philippine holiday calendar and `add_business_days`, trip pay dated by completion, composite client/site keys, sections reordered.

### Changes in v0.4
Security now verifies quantity **and** payout in the weekly sign-off; Security encodes workers' paper output sheets; returns have two modes (RPPC pickup, client delivers to plant) with damage class recorded where the check happens; added an approvals inbox with notifications and reminders; BAKLAS, PLAINER and CV defined; added a build guide for Claude Code (§19).

## 1. Business context

RPPC rents ECR wooden pallets (1200×1000 mm, block type, 4-way entry) to warehouses, distributors, manufacturers, FMCG companies and 3PLs. About 640,000 pallets have been deployed to date. Production is at the Mamplasan, Biñan, Laguna plant (roughly 10,000 pallets/month); lumber is milled in Mindanao and shipped by container.

**Today's problems** (from your brief and the attached files)

| Problem | Evidence |
|---|---|
| Everything runs on Excel, local storage and Google Drive backups | Brief |
| No sales order: sales ships from the proposal/contract and a delivery schedule | Brief |
| DR, gate pass and trip ticket made by hand | Brief |
| Proposals rebuilt per client in Word → PDF | Sample proposal (Onestop Warehousing, Oct 2024) |
| Production counts written on paper, keyed by guards, re-checked by HR in Excel | Production Tracker (one sheet per day, ~30 workers/day, 20+ activity lines) |
| Weekly payroll assembled manually (26–31 workers, ₱80k–₱162k/week in 2026) | Payroll Summary |
| Client concerns only in Messenger/Viber/WhatsApp, hard to trace | Brief |
| SAP B1 used for finance only; no inventory or purchasing module in use | Brief |

**Goals**

- G1 One record per order from proposal to billing, with no re-keying.
- G2 Prove every delivery (time in/out, photos, receiver signature).
- G3 Always know pallets per client site, per condition, and at the plant.
- G4 Bill on time: every invoice out before the 10th (25th for some clients).
- G5 Pay piece-rate workers from approved counts, automatically.
- G6 Secure by default: roles, approvals, segregation of duties, full audit trail.

**Scale:** under 100 users, ~3 trucks, a few thousand trips lifetime. A modular monolith on one PostgreSQL database is enough. Do not over-engineer.

## 2. Scope and phasing

| Phase | Modules | Exit criterion |
|---|---|---|
| **0 Foundation** | Auth, MFA, roles/permissions, audit log, approvals inbox and notifications, masters (clients, sites, trucks, zones, employees), file storage, doc numbering, opening-balance import | Users log in by role; every action audited |
| **1 Order-to-delivery** | Proposals & contracts, sales orders, work orders, trips/trip tickets, vouchers, DR, gate pass, proof of delivery (photos, signature, time in/out), pallet inventory ledger, billing summary + SAP export, dashboards | One real client runs end-to-end in the app; billing summary matches Excel |
| **2 Production & payroll, audit, CRM** | Daily production capture (phone), supervisor approval, piece-rate payroll, driver/helper trip pay, pallet audit, client concerns tracker, employee gate pass | One weekly payroll run reconciles to the manual one |
| **3 Procurement & field** | Purchase requisition/PO/receiving, materials inventory, container shipments from Mindanao, mobile onsite repair, client portal, messaging-channel integrations | — |

Out of scope: BIR invoice issuance, general ledger/AR/AP, statutory payroll deductions, truck GPS tracking, live SAP integration.

## 3. Users and roles

Roles map to your current org lineup. Titles, not names, are used so the spec survives staff changes. **Confirm the mapping.**

| Role code | Who | Main work |
|---|---|---|
| `OWNER` | President & CEO | Final approvals (payroll, rates), **approves every petty-cash voucher**, full read, break-glass |
| `ADMIN_IT` | IT & QA officer | Users, roles, settings. **Cannot approve business documents** |
| `OPS_MGR` | Pallet Operations Manager | Approves dehire, inventory adjustments, billing review |
| `SALES_MGR` | Overall Sales Manager | Approves proposals, SOs, accreditation |
| `SALES` | ECR rental, storage, export sales | Proposals, contracts, sales orders, client requests |
| `DEPLOY` | ECR pallet deployment officer | Work orders, trips, trip tickets, DR, vouchers, zone matrix |
| `AUDITOR` | CSR pallet auditor | Pallet audits, damage classification |
| `CSR_REPAIR` | CSR repair charges/materials | Repair charges, materials stock |
| `PURCHASING` | Purchasing officer | PR/PO/receiving (Phase 3) |
| `HR` | HR & QA officer | Weekly payroll verifier (quantity and payout), employees, gate passes; **distributes the Saturday cash payout** |
| `BILLING` | Billing staff/intern | Billing summaries, send to client, SAP export |
| `FINANCE` | Finance head / cashier | Releases petty-cash budgets, payroll cash, billing export |
| `SUPERVISOR` | Production Officer (supervisor/QC) | Approves production counts; weekly payroll verifier (quantity and payout) |
| `GUARD` | Security guard (gate) | Verifies gate pass; **encodes workers' paper output sheets**; weekly payroll verifier (quantity and payout); witnesses the cash payout |
| `DRIVER` / `HELPER` | Fleet crew | Own trips, loading/unloading confirmation, POD photos |
| `WORKER` | Pallet makers, painters | Own earnings; own counts only if self-entry is switched on |
| `CLIENT` | Client contact (Phase 3) | Read-only own DRs, billing summaries; raise concerns |

## 4. Business rules (testable)

| ID | Rule |
|---|---|
| BR-01 | A sales order needs an **accredited** client, a signed proposal conforme **or** signed contract, and an **active rate term** (`site_rate_terms`) covering the requested date for that site, so every delivery can be priced. |
| BR-02 | Minimum deployment order is 240 pallets (one truckload). Lower needs `so.override_min_qty` with a reason. |
| BR-03 | One trip carries at most the truck capacity (default 240). |
| BR-04 | A delivery trip cannot be dispatched until it has: trip ticket, **released** petty-cash voucher number, issued DR, issued gate pass. Client pickups skip the voucher (BR-26). |
| BR-05 | Delivery is `free` or `charged` per proposal. Charged = fee per trip from the zone matrix, **even for partial loads**. |
| BR-06 | Rent **starts** when pallets are delivered and the DR is signed and received at the client site (`received_at`). Rent **stops** when the RPPC team receives the pallets back: at the client site when RPPC collects them (often after an audit there), or at the RPPC plant when the client delivers them. The damage class is recorded where the check happens. Pallets on a truck are `in_transit` and are not billed. Day count uses the end-of-day on-site balance, so the day rent starts counts and the day rent stops does not. |
| BR-07 | Billing summary is per client site per period. The cutoff day is **set per client and can be changed at any time** (default 10th; Del Monte on the 25th *(assumed)*). A change applies from the next period and never to an issued summary. The summary must be client-approved before Finance invoices. |
| BR-08 | After the invoice is received, the client has 5 business days to dispute in writing, else it is deemed accepted. Business days exclude Saturdays, Sundays and dates in the `holidays` table (`add_business_days`). The app tracks the deadline. |
| BR-09 | Payment terms: 30 days from invoice receipt (displayed only; collections are in SAP). |
| BR-10 | Proposals have a validity date; expired ones cannot be converted without re-approval. A contract must be signed within 15 days after the first delivery; the app raises an alert. Delivery is allowed on a signed proposal conforme, and is billed at the proposal rate until the contract term takes over (BR-28). |
| BR-11 | Physical pallet audit with the client at least monthly, with 5 days' notice to the client. |
| BR-12 | Damage classes (default rates, VAT-exclusive): A free; B ₱200; C ₱400; D ₱800; E ₱1,300; BER ₱1,300; Lost = replacement cost. Overridable per contract. |
| BR-13 | Issued documents (SO, DR, gate pass, billing summary) are never edited or deleted. They are **voided** with a reason. Numbers are never reused. |
| BR-14 | Pallet movements are append-only. Corrections are reversal entries approved by `OPS_MGR`. |
| BR-15 | Production entries count for pay only after supervisor approval; rejected entries can be re-entered. Rates are snapshotted at entry. Approved entries of a closed payroll period are locked. |
| BR-16 | Payroll chain: computed by the **system job** (no person computes it) → weekly sign-off by Production Officer, HR, Security (each checks quantities **and** the payout) and Finance → Owner approved → paid Saturday afternoon → locked. Pay period is Saturday–Friday. A period can be reopened by the Owner only before it is `paid`; reopening starts a new sign-off round. |
| BR-17 | Driver and helper pay is a flat **₱1,000 (driver)** and **₱600 (helper)** per completed trip, regardless of distance or load size, paid in the weekly run of the week in which the trip was **completed**. Amounts are Owner-set and effective-dated. |
| BR-18 | Only pallets are billed. Components, paint and nails are not. |
| BR-19 | Dehire before lock-in end needs `OPS_MGR` approval and is flagged for Sales. |
| BR-20 | A trip becomes `delivered` only with at least 1 loaded photo and 1 unloaded photo (max 2 per stage), each **captured in the app with GPS and a device timestamp**, plus receiver name + signature and time-in/time-out. Counts are configurable. |
| BR-21 | No user approves a record they created or are paid by (see §8.3). |
| BR-22 | A DR may carry an attached Crystal Report–printed copy (its number and a scan). The system DR number stays the primary reference. |
| BR-23 | Every petty-cash voucher is **approved by the Owner**; the Finance head/cashier releases the budget. No budget ceiling. |
| BR-24 | Payday is Saturday afternoon. HR distributes the cash, Security witnesses; each payout is recorded and acknowledged by the worker. Distributor ≠ witness. |
| BR-25 | Photos far from the client site (default >300 m) or with a device clock off by more than 10 minutes are **flagged for review**, not blocked. |
| BR-26 | A **client pickup** (the client's own truck loads at the plant) has no RPPC fuel/toll budget, so it needs no voucher and no driver/helper trip pay. It still needs trip ticket, DR and gate pass; the signed DR is received at the plant, and rent starts then. |
| BR-27 | If the **Owner** requests a voucher himself, it is auto-approved and flagged `owner_raised`; Finance's release is still required and must be by a different person. |
| BR-28 | The rate applied to a day of rent is the one in the active `site_rate_terms` row for that site and date. A signed proposal creates a proposal term; the signed contract replaces it from the contract start date. Two active terms can never overlap, and a day with pallets on site but no term blocks finalising the billing summary. |

## 5. Functional requirements

### M1 Clients and sites
- Client master: legal name, TIN, billing contact, accreditation status (`prospect` → `accredited` → `suspended`), billing cutoff day (changeable any time, applies from the next period), payment terms.
- A **principal** is the billed client; delivery sites belong to the client. Billing summary is per site.
- Only `SALES_MGR` can accredit. Accreditation needs a document upload (e.g. credit/KYC form).

### M2 Proposals and contracts
- Templates with merge fields (client, address, attention, qty, rate per pallet/day, period, delivery free/charged, repair matrix, validity, signatory).
- Generate PDF in one click; store every version. Replaces the per-client Word files.
- Send by email from the app (logged). Record conforme: upload signed copy or capture e-signature.
- Standard contract generated from the accepted proposal. Renewal alerts at 90/60/30 days before end.
- Rates below the floor (`settings.min_rate`) need `SALES_MGR` approval.
- **Rate terms**: when a proposal conforme is signed the system creates a `proposal` rate term for the site, so deliveries made before the contract is signed are still priced (BR-28). When the contract is signed it takes over from its start date; the database refuses overlapping terms.

### M3 Sales orders
- Types: `deployment`, `dehire`, `pallet_audit`, `onsite_deployment`.
- Sales fills client, site, qty, requested date, contact. System checks BR-01/02.
- Statuses: `draft → submitted → approved → scheduled → in_progress → fulfilled | cancelled`.
- Principal lead-time capture and production/delivery schedule (Gantt-style list) is a v1.1 view.

### M4 Work orders, trips, trip tickets, vouchers
- Operations turns an approved SO into delivery work orders, split into trips of ≤240. A trip carries one or more **lines** (pallet type × condition × qty); quantities are never a single number on the trip.
- Each trip = **trip ticket** (system number) + **voucher no.** (pre-numbered petty cash pad, keyed in) + **DR**.
- Staff request a voucher; the **Owner approves every voucher**; the Finance head/cashier releases the cash; the deployment officer logs and monitors. A voucher the Owner raises himself is auto-approved and flagged (BR-27). **Client pickups need no voucher** (BR-26). A voided or rejected voucher can be re-issued for the same trip.
- Zone matrix with a cost generator (km × diesel use × price) to propose the budget and the client fee.
- Rescheduling logs a reason (production delay, truck unavailable, client request).

### M5 Delivery receipt, gate pass, proof of delivery
- DR and gate pass are generated from the trip, PDF with QR code (verify URL). One DR per trip. If a client requires it, attach the Crystal Report–printed DR (number + scan); the memorandum that system DRs are valid is stored with the settings.
- Guard scans the QR at the gate: confirms qty and plate, records time out.
- Driver/helper app flow: **Arrive → GPS-stamped photos of loaded pallets (1–2) → depart → arrive site → time-in → unload → GPS-stamped photos unloaded (1–2) → receiver name + signature → time-out**. Works offline and syncs later. The signed-receipt time is the **billing start** (BR-06). If the signed paper DR comes back later, Operations enters the received date/time and scans it, and the pallets then move to the client site in the ledger.
- **Client pickup:** the client's own truck loads at the plant. Same trip ticket, DR and gate pass, but no voucher, no in-transit stage and no crew trip pay; the DR is signed at the plant and rent starts then (BR-26).
- **Return / dehire:** two modes. (a) **RPPC collects**: the team counts the pallets at the client site (often after a pallet audit there), records the damage class per pallet, takes GPS-stamped photos and records the return receipt; rent stops at that time. (b) **Client delivers to the plant**: the RPPC team counts and classifies at the plant; rent stops at plant receipt. Pallets leave the client site in the ledger at the receipt time.

### M6 Pallet inventory
- Ledger of movements between locations: plant, each client site, in transit, repair area, and external (production in, lost, scrapped).
- Balance by location × condition (A–E, BER) × pallet type. Delivery issues stock; return/dehire receives it; audit variances post adjustments.
- Opening balances imported per site (§14).

### M7 Billing summary
- Auto-built from the ledger: pallet-days per site × the rate term in force each day (one line per rate if the period spans a proposal→contract change), plus delivery fees, repair/lost charges. A day with pallets on site but no rate term blocks finalising the summary. Live summaries for a site can never overlap in dates.
- Workflow: `draft → ops_reviewed → sent_to_client → client_approved | disputed → exported`.
- Export CSV/XLSX for Finance to key into SAP/Crystal. After invoicing, Billing records invoice no. and receipt date; app computes the 5-business-day dispute deadline using the holiday calendar (maintained in Admin).
- Dashboard: invoices not yet out as of the 8th/9th; KPI "all invoices before the 10th".

### M8 Production and piece-rate payroll (Phase 2)
- Default process (as today): the worker writes output on a **paper sheet** and gives it to **Security**, who verify it and **encode** it in the app. The sheet is photographed and attached. Workers with phones may enter their own counts later (setting `production.allow_self_entry`, default off). Activities: fabrication (BNEP), repair by class, painting, dipping, branding, chamfering, **plainer** (planing lumber, notches for bottom boards), **baklas** (dismantling whole pallets), loading, unloading (including container vans), plus onsite lines by the Mobile Repair Team.
- The Production Officer approves daily; the person who encoded an entry cannot approve it. Flags: count above the worker's norm, duplicates, plant-yard mismatch (produced vs received into plant stock).
- Weekly payroll is computed by a **system job** every Saturday morning for the Sat–Fri period (nobody computes their own pay); per-worker lines, and the owner's **Weekly Payroll Summary** (total, headcount, average, highest, lowest) is a built-in report.
- Driver and helper pay: flat ₱1,000 (driver) / ₱600 (helper) per completed trip, no distance factor, paid in the week the trip was completed. Drivers and helpers do not enter production counts.
- HR can read production and propose payroll **adjustments**; the Owner approves each one. The Owner can reopen a period only before it is paid; reopening voids the old sign-offs and starts a new round.
- Workers can see only their own earnings.
- Pay group: **weekly, Friday cutoff** for pallet makers, painters, onsite pallet makers, drivers and helpers. **Payday is Saturday afternoon**: HR hands out the cash with Security assisting, and each payout is acknowledged in the app. Admin staff (15th/30th) are not computed here.

### M9 Pallet audit (Phase 2)
- An audit may be done at the client site **before** a return; its damage classes feed the return receipt and the repair charges.
- Schedule with 5-day notice, count by condition class with a client representative, variance to system, charges per damage matrix, photo evidence.

### M10 Client concerns (CRM) (Phase 2)
- Ticket per concern: channel (Messenger, Viber, WhatsApp, email, call, visit), category, priority/SLA, assignee, linked DR/site/billing summary, thread and attachments.
- Phase 2: manual/forwarded entry and email-in. Phase 3: channel integrations (subject to provider approvals).

### M11 Procurement and materials (Phase 3)
- PR → approval by amount → PO → goods receipt → stock ledger. Lumber logs/components, nails, paint, chemicals, fuel.
- Container shipments from the Mindanao mill with received-vs-shipped reconciliation.

### M12 Admin
- Users, roles, permissions, settings, rate tables (effective-dated), **holiday calendar** (updated each year, used for business-day deadlines), audit log viewer, data exports.

### M13 Approvals inbox and notifications (Phase 0 skeleton, used by every module)
- Every record that waits for someone creates an **approval request** and notifies everyone who holds the approving permission: voucher → Owner; proposal/SO → Sales Manager; dehire/adjustment/billing review → Operations Manager; payroll sign-offs; production counts → Production Officer.
- Channels: in-app inbox with a count, **web push**, and **email** as fallback. Android Chrome supports push in the browser; on iPhone push works only when the app is installed to the Home Screen, so email stays on as backup.
- Open the notification → the record with **Approve / Reject** (reason required to reject). The requester can never approve their own request.
- Reminders: still pending after 2 hours in working hours → reminder (max 3). After 4 hours the Operations Manager gets an FYI (cannot approve). Daily digest of pending items at 07:30.
- Other alerts: contract and proposal expiry (90/60/30 days), billing cutoff in 3 days, dispute deadline, DR without proof of delivery, flagged photos, concern SLA due, backup failure. Users choose channels per kind, except security alerts.

## 6. Workflows (state machines)

```
SO:        draft → submitted → approved → scheduled → in_progress → fulfilled
                      ↓            ↓                        (any pre-fulfilled) → cancelled
                   rejected     (void only by SALES_MGR)

Trip:      delivery/return: planned → budget_approved → budget_released → loading → dispatched
                  → at_site → delivered → returned → closed        (cancel allowed before dispatched)
           client pickup (no voucher, BR-26): planned → loading → dispatched → delivered → closed

Billing:   draft → ops_reviewed → sent_to_client → client_approved → exported → invoiced
                                        ↘ disputed → (revised draft)

Payroll:   open → computed (by system job) → verifying (Production Officer, Security, HR, Finance each sign off) → owner_approved → paid (Saturday cash payout) → locked
           (each verifier checks the quantities and the payout; reopen allowed only before paid, new round)
```

Ledger timing: **dispatch** moves pallets plant → in_transit (not billable); **signed DR received** moves in_transit → client site (billing starts). Any shortfall is returned in_transit → plant in the same transaction. Every in-transit movement carries the trip id, so each truck is tracked separately. A client pickup goes plant → client site directly when the DR is signed. **Returns:** if RPPC collects, pallets move client site → in_transit when the RPPC team receives them (rent stops) and in_transit → plant on arrival; if the client delivers, they move client site → plant at the plant receipt (rent stops).


Every transition names the permission it needs (see §10.4) and writes an audit row.

## 7. Data model (PostgreSQL 16)

Conventions: `uuid` primary keys, `timestamptz` in UTC (display in Asia/Manila), money `numeric(14,2)` in PHP, no hard deletes for business documents (status `void`), every table has `created_at`/`updated_at`.

### 7.1 Foundation: identity, RBAC, files, numbering, audit

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME; END $$ LANGUAGE plpgsql;

CREATE TABLE employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_no     text UNIQUE NOT NULL,
  full_name       text NOT NULL,
  position        text,
  department      text,
  pay_type        text NOT NULL DEFAULT 'piece_rate'
                  CHECK (pay_type IN ('monthly','daily','piece_rate','trip')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  mobile          text,
  hired_on        date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        citext UNIQUE NOT NULL,
  email           citext UNIQUE,
  full_name       text NOT NULL,
  auth_method     text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password','pin')),
  password_hash   text,                         -- argon2id (office users)
  pin_hash        text,                         -- argon2id (field users, device-bound)
  mfa_secret_enc  bytea,                        -- TOTP secret, app-level encrypted
  mfa_enabled     boolean NOT NULL DEFAULT false,
  employee_id     uuid REFERENCES employees(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((auth_method = 'password' AND password_hash IS NOT NULL)
      OR (auth_method = 'pin' AND pin_hash IS NOT NULL))
);

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text UNIQUE NOT NULL,
  name         text NOT NULL,
  requires_mfa boolean NOT NULL DEFAULT false,
  is_system    boolean NOT NULL DEFAULT false
);
CREATE TABLE permissions (
  code        text PRIMARY KEY,               -- e.g. 'so.approve'
  description text NOT NULL
);
CREATE TABLE role_permissions (
  role_id         uuid REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);
CREATE TABLE user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id),
  scope_type text CHECK (scope_type IN ('client','site')),   -- for CLIENT portal users
  scope_id   uuid
);
CREATE UNIQUE INDEX user_roles_uq ON user_roles
  (user_id, role_id, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea UNIQUE NOT NULL,          -- sha256 of the opaque cookie token
  device_id    uuid,
  ip           inet,
  user_agent   text,
  mfa_passed   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);

CREATE TABLE devices (                          -- enrolled phones for PIN users
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  label      text,
  enrolled_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text UNIQUE NOT NULL,
  original_name text,
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
  sha256      bytea NOT NULL,
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected')),
  uploaded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Gap-free document numbers per type per (Manila) year. Same transaction as the document.
CREATE TABLE doc_sequences (
  doc_type   text NOT NULL,
  yr         int  NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type, yr)
);
CREATE OR REPLACE FUNCTION next_doc_no(p_type text, p_prefix text) RETURNS text AS $$
DECLARE v_yr int := EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Manila'))::int; v_n bigint;
BEGIN
  INSERT INTO doc_sequences AS s (doc_type, yr, last_value) VALUES (p_type, v_yr, 1)
  ON CONFLICT (doc_type, yr) DO UPDATE SET last_value = s.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN format('%s-%s-%s', p_prefix, v_yr, lpad(v_n::text, 6, '0'));
END $$ LANGUAGE plpgsql;

-- Tamper-evident audit log (hash chain, append-only)
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  actor_roles text[],
  action      text NOT NULL,                   -- 'so.approve', 'auth.login_failed', ...
  entity_type text,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  ip          inet,
  user_agent  text,
  request_id  text,
  prev_hash   bytea,
  hash        bytea
);
-- One hash function used by BOTH the trigger and the verifier. The timestamp is hashed as fixed UTC text, so the
-- result never depends on a session time zone; NULLs get an explicit marker so null/absent cannot be confused.
CREATE OR REPLACE FUNCTION audit_row_hash(p_prev bytea, p_id bigint, p_at timestamptz, p_actor uuid, p_action text,
  p_etype text, p_eid uuid, p_before jsonb, p_after jsonb) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT digest(p_prev || convert_to(concat_ws('|',
    p_id::text,
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    COALESCE(p_actor::text, '<null>'), p_action, COALESCE(p_etype, '<null>'), COALESCE(p_eid::text, '<null>'),
    COALESCE(p_before::text, '<null>'), COALESCE(p_after::text, '<null>')), 'UTF8'), 'sha256')
$$;
CREATE OR REPLACE FUNCTION trg_audit_chain() RETURNS trigger AS $$
DECLARE v_prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);
  SELECT hash INTO v_prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(v_prev, '\x00'::bytea);
  NEW.hash := audit_row_hash(NEW.prev_hash, NEW.id, NEW.at, NEW.actor_id, NEW.action,
                             NEW.entity_type, NEW.entity_id, NEW.before, NEW.after);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION trg_audit_chain();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION fn_verify_audit_chain() RETURNS TABLE(broken_at bigint) LANGUAGE plpgsql AS $$
DECLARE r record; v_prev bytea := '\x00'::bytea;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM v_prev OR r.hash IS DISTINCT FROM
       audit_row_hash(v_prev, r.id, r.at, r.actor_id, r.action, r.entity_type, r.entity_id, r.before, r.after) THEN
      broken_at := r.id; RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
  END LOOP;
END $$;

-- Philippine holiday calendar, kept up to date each year by an admin (proclamations add special days).
CREATE TABLE holidays (hdate date PRIMARY KEY, name text NOT NULL, kind text NOT NULL DEFAULT 'national');
-- Business days = Monday–Friday that are not in holidays. Used for the 5-business-day dispute deadline (BR-08).
CREATE OR REPLACE FUNCTION add_business_days(p_from date, p_days int) RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE d date := p_from; n int := 0;
BEGIN
  WHILE n < p_days LOOP
    d := d + 1;
    IF EXTRACT(ISODOW FROM d) < 6 AND NOT EXISTS (SELECT 1 FROM holidays WHERE hdate = d) THEN n := n + 1; END IF;
  END LOOP;
  RETURN d;
END $$;
```

### 7.2 Masters

```sql
CREATE TABLE clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text UNIQUE NOT NULL,
  legal_name     text NOT NULL,
  trade_name     text,
  tin            text,
  address        text,
  status         text NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect','accredited','suspended')),
  accredited_by  uuid REFERENCES users(id),
  accredited_at  timestamptz,
  payment_terms_days int NOT NULL DEFAULT 30,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_cutoff_settings (          -- cutoff can change anytime; history is kept
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  cutoff_day int NOT NULL CHECK (cutoff_day BETWEEN 1 AND 28),
  effective_from date NOT NULL,                 -- applies from the next period start, never to issued summaries
  set_by uuid NOT NULL REFERENCES users(id), reason text,
  UNIQUE (client_id, effective_from)
);
-- Cutoff in force on a date = the row with the latest effective_from <= that date; 10 if there is none.

CREATE TABLE delivery_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL, region text NOT NULL CHECK (region IN ('Luzon','Visayas','Mindanao')),
  km_from_plant numeric(8,1)
);
CREATE TABLE zone_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES delivery_zones(id),
  fee_per_trip numeric(12,2) NOT NULL CHECK (fee_per_trip >= 0),
  est_trip_cost numeric(12,2),                 -- diesel/toll/etc, from cost generator
  effective_from date NOT NULL, effective_to date
);

CREATE TABLE client_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  name text NOT NULL, address text NOT NULL,
  region text CHECK (region IN ('Luzon','Visayas','Mindanao')),
  zone_id uuid REFERENCES delivery_zones(id),
  lat numeric(9,6), lng numeric(9,6), geofence_m int NOT NULL DEFAULT 300,   -- flags photos taken far from the site
  contact_name text, contact_mobile text,
  UNIQUE (client_id, name),
  UNIQUE (id, client_id)                       -- target of composite foreign keys (SO, DR, billing)
);

CREATE TABLE pallet_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,                   -- 'ECR-1200x1000'
  length_mm int, width_mm int, height_mm int,
  dynamic_load_kg int, static_load_kg int
);
CREATE TABLE trucks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_no text UNIQUE NOT NULL, capacity_pallets int NOT NULL DEFAULT 240,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired'))
);
```

### 7.3 Commercial: proposals, contracts

```sql
CREATE TABLE document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('proposal','contract')),
  code text NOT NULL, version int NOT NULL, body_html text NOT NULL,
  active boolean NOT NULL DEFAULT true, UNIQUE (kind, code, version)
);

CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_no text UNIQUE NOT NULL DEFAULT next_doc_no('PROP','PRP'),
  client_id uuid NOT NULL REFERENCES clients(id),
  attention_to text, template_id uuid REFERENCES document_templates(id),
  pallet_type_id uuid NOT NULL REFERENCES pallet_types(id),
  min_qty int NOT NULL DEFAULT 240 CHECK (min_qty >= 1),
  rate_per_pallet_day numeric(10,4) NOT NULL CHECK (rate_per_pallet_day > 0),   -- VAT-exclusive
  contract_months int NOT NULL DEFAULT 12,
  delivery_mode text NOT NULL DEFAULT 'charged' CHECK (delivery_mode IN ('free','charged')),
  damage_rates jsonb NOT NULL,                 -- snapshot of the A–E/BER/Lost matrix
  terms jsonb NOT NULL DEFAULT '{}',
  valid_until date NOT NULL,
  status text NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','pending_approval','approved','sent','conforme_signed','expired','void')),
  pdf_file_id uuid REFERENCES files(id), conforme_file_id uuid REFERENCES files(id),
  conforme_signed_on date,
  created_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_no text UNIQUE NOT NULL DEFAULT next_doc_no('CONT','CTR'),
  client_id uuid NOT NULL REFERENCES clients(id),
  proposal_id uuid REFERENCES proposals(id),
  rate_per_pallet_day numeric(10,4) NOT NULL,
  min_qty int NOT NULL DEFAULT 240,
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('free','charged')),
  damage_rates jsonb NOT NULL,
  start_date date NOT NULL, end_date date NOT NULL CHECK (end_date > start_date),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','signed','expired','terminated')),
  signed_file_id uuid REFERENCES files(id), signed_on date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contract_sites (
  contract_id uuid REFERENCES contracts(id), site_id uuid REFERENCES client_sites(id),
  PRIMARY KEY (contract_id, site_id)
);

-- What rate applies to a site on a given day. Created when a proposal conforme is signed (delivery is allowed
-- on it, BR-10) and replaced by a contract term when the contract is signed. The EXCLUDE constraint makes it
-- impossible for two active terms to cover the same site on the same day, so pallet-days can never be
-- double-counted during a renewal or an overlap, and a delivery before the contract is signed is still priced.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE site_rate_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES client_sites(id),
  source_type text NOT NULL CHECK (source_type IN ('proposal','contract')),
  proposal_id uuid REFERENCES proposals(id), contract_id uuid REFERENCES contracts(id),
  rate_per_pallet_day numeric(10,4) NOT NULL CHECK (rate_per_pallet_day > 0),   -- VAT-exclusive
  effective_from date NOT NULL, effective_to date,                              -- NULL = open-ended
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_type = 'proposal' AND proposal_id IS NOT NULL AND contract_id IS NULL)
      OR (source_type = 'contract' AND contract_id IS NOT NULL AND proposal_id IS NULL)),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  EXCLUDE USING gist (site_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&) WHERE (status = 'active')
);
-- Lifecycle (done by the app in one transaction):
--  * proposal conforme signed  -> insert a 'proposal' term from the conforme/first-delivery date.
--  * contract signed           -> end the proposal term the day before the contract start_date, or void it if the
--                                 contract starts the same day or earlier; insert a 'contract' term from start_date.
--  * renewal                   -> new contract term starts the day after the old one ends.
-- A sales order for a site can be approved only if an active term covers the requested date (BR-01).
```

### 7.4 Orders, trips, DR, gate pass, proof of delivery

```sql
CREATE TABLE sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_no text UNIQUE NOT NULL DEFAULT next_doc_no('SO','SO'),
  order_type text NOT NULL CHECK (order_type IN ('deployment','dehire','pallet_audit','onsite_deployment')),
  client_id uuid NOT NULL REFERENCES clients(id),
  site_id uuid NOT NULL,
  proposal_id uuid REFERENCES proposals(id), contract_id uuid REFERENCES contracts(id),
  qty int NOT NULL CHECK (qty > 0),
  min_qty_override_reason text,
  requested_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','submitted','approved','rejected','scheduled','in_progress','fulfilled','cancelled','void')),
  created_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (proposal_id IS NOT NULL OR contract_id IS NOT NULL OR order_type = 'pallet_audit'),
  FOREIGN KEY (site_id, client_id) REFERENCES client_sites (id, client_id),   -- a site can never belong to another client's order
  UNIQUE (id, client_id, site_id)                                              -- target for the DR composite key
);

CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_no text UNIQUE NOT NULL DEFAULT next_doc_no('WO','WO'),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id),
  qty int NOT NULL CHECK (qty > 0), planned_date date NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','cancelled')),
  reschedule_log jsonb NOT NULL DEFAULT '[]',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_no text UNIQUE NOT NULL DEFAULT next_doc_no('TRIP','TT'),        -- the trip ticket number
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  -- delivery = RPPC truck to client; return = RPPC truck collects from client; pickup = client's own truck loads at the
  -- plant (no RPPC fuel/toll budget, so no voucher, BR-26); internal = plant to plant.
  trip_type text NOT NULL DEFAULT 'delivery' CHECK (trip_type IN ('delivery','pickup','return','internal')),
  voucher_required boolean GENERATED ALWAYS AS (trip_type <> 'pickup') STORED,
  truck_id uuid REFERENCES trucks(id), driver_id uuid REFERENCES employees(id),
  planned_date date NOT NULL,
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('free','charged')),
  zone_id uuid REFERENCES delivery_zones(id),
  delivery_fee numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned'
         CHECK (status IN ('planned','budget_approved','budget_released','loading','dispatched',
                           'at_site','delivered','returned','closed','cancelled')),
  completed_at timestamptz,                      -- set when the trip is delivered/closed; trip pay is earned on this date
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- A trip can carry several pallet types/conditions; quantities live here, never as one number on the trip.
CREATE TABLE trip_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  pallet_type_id uuid NOT NULL REFERENCES pallet_types(id),
  condition text NOT NULL CHECK (condition IN ('new','A','B','C','D','E','BER')),
  qty_planned int NOT NULL CHECK (qty_planned > 0),
  qty_loaded int CHECK (qty_loaded >= 0), qty_delivered int CHECK (qty_delivered >= 0),
  UNIQUE (trip_id, pallet_type_id, condition)
);
CREATE VIEW v_trip_qty AS
  SELECT trip_id, sum(qty_planned) AS planned, sum(qty_loaded) AS loaded, sum(qty_delivered) AS delivered
  FROM trip_lines GROUP BY trip_id;
CREATE TABLE trip_helpers (
  trip_id uuid REFERENCES trips(id) ON DELETE CASCADE, employee_id uuid REFERENCES employees(id),
  PRIMARY KEY (trip_id, employee_id)
);
CREATE TABLE trip_events (                      -- time in / time out and the rest of the timeline
  id bigserial PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id),
  event text NOT NULL CHECK (event IN ('loading_start','loading_end','departed_plant','arrived_site',
        'unloading_start','unloading_end','departed_site','returned_plant')),
  at timestamptz NOT NULL, device_at timestamptz, recorded_by uuid REFERENCES users(id),
  lat numeric(9,6), lng numeric(9,6),          -- GPS stamped only at the moment of a check-in (no continuous tracking)
  UNIQUE (trip_id, event)
);

CREATE TABLE vouchers (                         -- pre-numbered petty cash voucher attached to a trip
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_no text UNIQUE NOT NULL,              -- keyed from the physical pad
  trip_id uuid NOT NULL REFERENCES trips(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','released','liquidated','rejected','void')),
  budget_amount numeric(12,2) NOT NULL CHECK (budget_amount >= 0),
  requested_by uuid NOT NULL REFERENCES users(id),
  owner_raised boolean NOT NULL DEFAULT false,  -- Owner requested it himself: auto-approved, flagged, Finance release is still independent
  approved_by uuid REFERENCES users(id), approved_at timestamptz,   -- always the Owner (BR-23)
  released_by uuid REFERENCES users(id), released_at timestamptz,
  actual_amount numeric(12,2), liquidated_at timestamptz,
  void_reason text,
  CHECK (approved_by IS NULL OR approved_by <> requested_by OR owner_raised),
  CHECK (NOT owner_raised OR approved_by = requested_by),
  CHECK (released_by IS NULL OR (released_by <> requested_by AND released_by IS DISTINCT FROM approved_by))
);
-- One live voucher per trip; a voided/rejected one can be re-issued.
CREATE UNIQUE INDEX voucher_one_live_per_trip ON vouchers (trip_id) WHERE status NOT IN ('void','rejected');

CREATE TABLE delivery_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dr_no text UNIQUE NOT NULL DEFAULT next_doc_no('DR','DR'),
  trip_id uuid NOT NULL REFERENCES trips(id),
  sales_order_id uuid NOT NULL, client_id uuid NOT NULL, site_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),               -- total of the trip lines; the PDF lists each type/condition line
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','delivered','received','disputed','void')),
  receiver_name text, receiver_signature_file_id uuid REFERENCES files(id),
  delivered_at timestamptz,                       -- unloading finished
  received_at timestamptz,                        -- signed and received at client site = billing start (BR-06)
  external_dr_no text, external_dr_file_id uuid REFERENCES files(id),   -- optional Crystal Report-printed copy (BR-22)
  void_reason text,
  pdf_file_id uuid REFERENCES files(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sales_order_id, client_id, site_id) REFERENCES sales_orders (id, client_id, site_id)
);
-- One live DR per trip (BR-04). Voiding frees the trip so a corrected DR can be issued; the void DR keeps its number.
CREATE UNIQUE INDEX dr_one_live_per_trip ON delivery_receipts (trip_id) WHERE status <> 'void';
CREATE TABLE gate_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gp_no text UNIQUE NOT NULL DEFAULT next_doc_no('GP','GP'),
  trip_id uuid NOT NULL REFERENCES trips(id),
  qty int NOT NULL, verified_by uuid REFERENCES users(id), time_out timestamptz, status text NOT NULL DEFAULT 'issued'
       CHECK (status IN ('issued','verified','void'))
);
CREATE UNIQUE INDEX gp_one_live_per_trip ON gate_passes (trip_id) WHERE status <> 'void';
CREATE TABLE pod_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  stage text NOT NULL CHECK (stage IN ('loaded','unloaded','damage','other')),
  file_id uuid NOT NULL REFERENCES files(id),
  taken_at_device timestamptz, uploaded_at timestamptz NOT NULL DEFAULT now(),   -- uploaded_at = server time
  lat numeric(9,6), lng numeric(9,6), gps_accuracy_m numeric(8,1),
  captured_in_app boolean NOT NULL DEFAULT true,       -- camera in the PWA, no gallery picks
  flags text[] NOT NULL DEFAULT '{}',                  -- 'outside_geofence','clock_skew','low_gps_accuracy'
  uploaded_by uuid NOT NULL REFERENCES users(id),
  CHECK (stage NOT IN ('loaded','unloaded')
         OR (lat IS NOT NULL AND lng IS NOT NULL AND taken_at_device IS NOT NULL AND captured_in_app))
);
CREATE INDEX ON pod_photos (trip_id, stage);

-- Returns / dehire (BR-06). Rent stops at received_at.
CREATE TABLE return_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rr_no text UNIQUE NOT NULL DEFAULT next_doc_no('RR','RR'),
  client_id uuid NOT NULL REFERENCES clients(id), site_id uuid NOT NULL,
  return_mode text NOT NULL CHECK (return_mode IN ('rppc_pickup','client_delivers')),
  classified_at text NOT NULL CHECK (classified_at IN ('client_site','rppc_plant')),
  audit_id uuid,                                  -- optional link to a pallet audit done before the return
  trip_id uuid REFERENCES trips(id),              -- RPPC pickup trip, when RPPC collects
  received_at timestamptz NOT NULL,               -- rent stops here
  received_by uuid NOT NULL REFERENCES users(id),
  client_rep_name text, client_ack_file_id uuid REFERENCES files(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','received','void')),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, client_id) REFERENCES client_sites (id, client_id)
);
CREATE TABLE return_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_receipt_id uuid NOT NULL REFERENCES return_receipts(id) ON DELETE CASCADE,
  pallet_type_id uuid NOT NULL REFERENCES pallet_types(id),
  condition text NOT NULL CHECK (condition IN ('A','B','C','D','E','BER','lost')),   -- 'lost' = not returned, charged
  qty int NOT NULL CHECK (qty > 0),
  UNIQUE (return_receipt_id, pallet_type_id, condition)
);
```

### 7.5 Pallet inventory ledger and rental days

```sql
CREATE TABLE inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('plant','client_site','in_transit','repair_area','external')),
  site_id uuid REFERENCES client_sites(id),
  name text NOT NULL UNIQUE,
  CHECK ((type = 'client_site') = (site_id IS NOT NULL))
);

CREATE TABLE pallet_movements (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  pallet_type_id uuid NOT NULL REFERENCES pallet_types(id),
  condition text NOT NULL CHECK (condition IN ('new','A','B','C','D','E','BER')),
  qty int NOT NULL CHECK (qty > 0),
  from_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  to_location_id   uuid NOT NULL REFERENCES inventory_locations(id),
  ref_type text NOT NULL, ref_id uuid,           -- 'delivery_receipt', 'audit', 'production', 'reversal', ...
  trip_id uuid REFERENCES trips(id),             -- REQUIRED on every movement into/out of 'in_transit' (so each truck is tracked on its own)
  reversal_of bigint REFERENCES pallet_movements(id),
  note text, created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_location_id <> to_location_id)
);
CREATE INDEX ON pallet_movements (to_location_id, occurred_at);
CREATE INDEX ON pallet_movements (from_location_id, occurred_at);
CREATE TRIGGER pallet_movements_immutable BEFORE UPDATE OR DELETE ON pallet_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Block negative stock at any non-'external' source location
CREATE OR REPLACE FUNCTION trg_pallet_movement_guard() RETURNS trigger AS $$
DECLARE v_type text; v_to_type text; v_balance bigint;
BEGIN
  SELECT type INTO v_type FROM inventory_locations WHERE id = NEW.from_location_id;
  SELECT type INTO v_to_type FROM inventory_locations WHERE id = NEW.to_location_id;
  IF (v_type = 'in_transit' OR v_to_type = 'in_transit') AND NEW.trip_id IS NULL THEN
    RAISE EXCEPTION 'Movements to/from in_transit must carry a trip_id';
  END IF;
  IF v_type <> 'external' THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.from_location_id::text));
    SELECT COALESCE(SUM(CASE WHEN to_location_id = NEW.from_location_id THEN qty ELSE -qty END), 0)
      INTO v_balance
      FROM pallet_movements
     WHERE (to_location_id = NEW.from_location_id OR from_location_id = NEW.from_location_id)
       AND pallet_type_id = NEW.pallet_type_id AND condition = NEW.condition
       AND (v_type <> 'in_transit' OR trip_id = NEW.trip_id);   -- a truck can only unload what that truck loaded
    IF v_balance < NEW.qty THEN
      RAISE EXCEPTION 'Insufficient stock at location % (have %, need %)', NEW.from_location_id, v_balance, NEW.qty;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pallet_movement_guard BEFORE INSERT ON pallet_movements
  FOR EACH ROW EXECUTE FUNCTION trg_pallet_movement_guard();

CREATE VIEW v_pallet_balance AS
SELECT loc_id AS location_id, pallet_type_id, condition, SUM(delta)::bigint AS qty
FROM (
  SELECT to_location_id AS loc_id, pallet_type_id, condition,  qty AS delta FROM pallet_movements
  UNION ALL
  SELECT from_location_id,          pallet_type_id, condition, -qty        FROM pallet_movements
) m GROUP BY loc_id, pallet_type_id, condition;

-- What each trip is carrying right now (should be empty once every trip is delivered or returned).
CREATE VIEW v_trip_in_transit AS
SELECT m.trip_id, m.pallet_type_id, m.condition,
       SUM(CASE WHEN l.type = 'in_transit' AND m.to_location_id = l.id THEN m.qty ELSE -m.qty END)::bigint AS qty
FROM pallet_movements m
JOIN inventory_locations l ON l.type = 'in_transit' AND (l.id = m.to_location_id OR l.id = m.from_location_id)
WHERE m.trip_id IS NOT NULL
GROUP BY m.trip_id, m.pallet_type_id, m.condition
HAVING SUM(CASE WHEN l.type = 'in_transit' AND m.to_location_id = l.id THEN m.qty ELSE -m.qty END) <> 0;

-- End-of-day on-site balance per day (Asia/Manila). Basis of rental billing (BR-06).
CREATE OR REPLACE FUNCTION fn_location_daily_balance(p_loc uuid, p_type uuid, p_from date, p_to date)
RETURNS TABLE(day date, qty_on_hand bigint) LANGUAGE sql STABLE AS $$
  WITH opening AS (
    SELECT COALESCE(SUM(CASE WHEN to_location_id = p_loc THEN qty ELSE -qty END), 0) AS q
      FROM pallet_movements
     WHERE pallet_type_id = p_type
       AND (occurred_at AT TIME ZONE 'Asia/Manila')::date < p_from
       AND (to_location_id = p_loc OR from_location_id = p_loc)
  ), deltas AS (
    SELECT (occurred_at AT TIME ZONE 'Asia/Manila')::date AS d,
           SUM(CASE WHEN to_location_id = p_loc THEN qty ELSE -qty END) AS delta
      FROM pallet_movements
     WHERE pallet_type_id = p_type
       AND (occurred_at AT TIME ZONE 'Asia/Manila')::date BETWEEN p_from AND p_to
       AND (to_location_id = p_loc OR from_location_id = p_loc)
     GROUP BY 1
  ), days AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS d
  )
  SELECT days.d,
         ((SELECT q FROM opening) + SUM(COALESCE(deltas.delta, 0)) OVER (ORDER BY days.d))::bigint
    FROM days LEFT JOIN deltas ON deltas.d = days.d
   ORDER BY days.d;
$$;
```

### 7.6 Billing summary

```sql
CREATE TABLE billing_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bs_no text UNIQUE NOT NULL DEFAULT next_doc_no('BS','BS'),
  client_id uuid NOT NULL REFERENCES clients(id), site_id uuid NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL CHECK (period_end >= period_start),
  pallet_days bigint NOT NULL DEFAULT 0,          -- total across rate lines; the rate(s) live on the lines below
  rental_amount numeric(14,2) NOT NULL DEFAULT 0,
  other_charges numeric(14,2) NOT NULL DEFAULT 0,
  total_vat_ex numeric(14,2) GENERATED ALWAYS AS (rental_amount + other_charges) STORED,
  status text NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','ops_reviewed','sent_to_client','client_approved','disputed','exported','invoiced','void')),
  sent_at timestamptz, client_approved_at timestamptz, client_approver_name text, approval_file_id uuid REFERENCES files(id),
  exported_at timestamptz, exported_by uuid REFERENCES users(id),
  invoice_ref text, invoice_received_on date, dispute_deadline date,   -- add_business_days(invoice_received_on, 5), BR-08
  void_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, client_id) REFERENCES client_sites (id, client_id),
  -- No two live summaries may overlap for the same site, so a day can never be billed twice. A voided one frees its dates.
  EXCLUDE USING gist (site_id WITH =, daterange(period_start, period_end, '[]') WITH &&) WHERE (status <> 'void')
);
CREATE TABLE billing_summary_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_id uuid NOT NULL REFERENCES billing_summaries(id) ON DELETE CASCADE,
  line_type text NOT NULL CHECK (line_type IN ('rental','delivery_fee','repair','lost','other')),
  rate_term_id uuid REFERENCES site_rate_terms(id),    -- which proposal/contract term priced a rental line
  ref_type text, ref_id uuid, description text NOT NULL,
  qty numeric(14,2) NOT NULL, unit_rate numeric(12,4) NOT NULL, amount numeric(14,2) NOT NULL
);
```

Rental line computation (one query per site and period). The rate comes from `site_rate_terms`, so a delivery made after
the proposal conforme but before the contract is signed is billed at the proposal rate (BR-01, BR-10), and a period that
spans a proposal→contract change produces one line per rate. Any day with pallets on site but **no active rate term** is
returned as `unpriced_days`; the app refuses to finalise the summary while that is above zero (never bills ₱0 silently).

```sql
WITH days AS (                                   -- end-of-day pallets on site, all pallet types, per day
  SELECT b.day, SUM(b.qty_on_hand) AS pallets
  FROM inventory_locations l
  CROSS JOIN pallet_types pt
  CROSS JOIN LATERAL fn_location_daily_balance(l.id, pt.id, :period_start, :period_end) b
  WHERE l.site_id = :site_id
  GROUP BY b.day
), priced AS (
  SELECT d.day, d.pallets, t.id AS term_id, t.rate_per_pallet_day
  FROM days d
  LEFT JOIN site_rate_terms t
         ON t.site_id = :site_id AND t.status = 'active'
        AND d.day BETWEEN t.effective_from AND COALESCE(t.effective_to, 'infinity'::date)
  WHERE d.pallets > 0
)
SELECT term_id, rate_per_pallet_day,
       SUM(pallets)                                           AS pallet_days,
       ROUND(SUM(pallets) * rate_per_pallet_day, 2)           AS rental_amount,
       COUNT(*) FILTER (WHERE term_id IS NULL)                AS unpriced_days
FROM priced
GROUP BY term_id, rate_per_pallet_day;
```

### 7.7 Production and payroll (Phase 2)

```sql
CREATE TABLE production_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL, name text NOT NULL,
  category text NOT NULL CHECK (category IN ('fabrication','repair','painting','dipping','branding',
            'chamfering','planing','dismantling','loading','unloading','daily','onsite','other')),
  unit text NOT NULL DEFAULT 'pc' CHECK (unit IN ('pc','day','lot')),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE activity_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES production_activities(id),
  client_id uuid REFERENCES clients(id),         -- client-specific rate, e.g. branding for one client
  rate numeric(10,2) NOT NULL CHECK (rate >= 0),
  effective_from date NOT NULL, effective_to date,
  set_by uuid NOT NULL REFERENCES users(id),     -- OWNER only
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  EXCLUDE USING gist (activity_id WITH =, (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
                      daterange(effective_from, effective_to, '[]') WITH &&)   -- one rate per activity/client per day
);

CREATE TABLE production_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_date date NOT NULL,
  worker_id uuid NOT NULL REFERENCES employees(id),
  activity_id uuid NOT NULL REFERENCES production_activities(id),
  client_id uuid REFERENCES clients(id),
  qty numeric(10,2) NOT NULL CHECK (qty >= 0),
  rate_snapshot numeric(10,2) NOT NULL,
  amount numeric(12,2) GENERATED ALWAYS AS (ROUND(qty * rate_snapshot, 2)) STORED,
  entered_by uuid NOT NULL REFERENCES users(id),
  entered_via text NOT NULL CHECK (entered_via IN ('self','supervisor','guard')),
  source_sheet_file_id uuid REFERENCES files(id),     -- photo of the paper output sheet
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','locked')),
  flags text[] NOT NULL DEFAULT '{}',            -- 'above_norm','duplicate','yard_mismatch'
  approved_by uuid REFERENCES users(id), approved_at timestamptz, reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> entered_by)   -- approver ≠ enterer; "not the payee" is checked in the app (§8.3)
);
-- Duplicate guard that still lets a rejected entry be re-entered correctly.
CREATE UNIQUE INDEX production_entry_uq ON production_entries
  (work_date, worker_id, activity_id, COALESCE(client_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status <> 'rejected';

CREATE TABLE payroll_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start date NOT NULL, period_end date NOT NULL, week_no int, yr int NOT NULL,
  pay_group text NOT NULL DEFAULT 'weekly_piece_rate' CHECK (pay_group IN ('weekly_piece_rate')),   -- one weekly run: piece-rate + flat trip pay
  status text NOT NULL DEFAULT 'open'
         CHECK (status IN ('open','computed','verifying','owner_approved','paid','locked')),
  round int NOT NULL DEFAULT 1,                  -- bumped on every recompute/reopen; old sign-offs belong to an older round
  computed_at timestamptz, computed_by_job text, -- computed by the system job, never by a person (no one computes their own pay)
  total_snapshot numeric(14,2),                  -- grand total at compute time; sign-offs are given on this figure
  owner_approved_by uuid REFERENCES users(id), owner_approved_at timestamptz,
  CHECK (EXTRACT(ISODOW FROM period_start) = 6 AND period_end = period_start + 6),   -- Saturday to Friday
  UNIQUE (pay_group, period_start, period_end),
  EXCLUDE USING gist (pay_group WITH =, daterange(period_start, period_end, '[]') WITH &&)
);
-- Reopen is allowed only before 'paid' (Owner, with a reason, audited). It sets status back to 'open' and round = round + 1,
-- so earlier sign-offs stay on record but no longer count.
CREATE TABLE payroll_verifications (            -- four separate sign-offs before Owner approval
  period_id   uuid NOT NULL REFERENCES payroll_periods(id),
  round       int  NOT NULL,
  step        text NOT NULL CHECK (step IN ('production','security','hr','finance')),
  verified_by uuid NOT NULL REFERENCES users(id),
  total_seen  numeric(14,2) NOT NULL,           -- the total the verifier saw; must equal payroll_periods.total_snapshot
  verified_at timestamptz NOT NULL DEFAULT now(), note text,
  PRIMARY KEY (period_id, round, step),
  UNIQUE (period_id, round, verified_by)        -- one person cannot cover two of the four sign-offs
);
CREATE TABLE payroll_payouts (                  -- Saturday-afternoon cash distribution
  period_id    uuid NOT NULL REFERENCES payroll_periods(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  amount       numeric(12,2) NOT NULL CHECK (amount >= 0),
  paid_by      uuid NOT NULL REFERENCES users(id),          -- HR
  witnessed_by uuid NOT NULL REFERENCES users(id),          -- Security
  paid_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged boolean NOT NULL DEFAULT false, signature_file_id uuid REFERENCES files(id),
  PRIMARY KEY (period_id, employee_id),
  CHECK (paid_by <> witnessed_by)
);
CREATE TABLE trip_pay_rates (                   -- flat pay per trip, by crew role
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_role text NOT NULL CHECK (crew_role IN ('driver','helper')),
  amount_per_trip numeric(10,2) NOT NULL CHECK (amount_per_trip >= 0),
  effective_from date NOT NULL, effective_to date,
  set_by uuid NOT NULL REFERENCES users(id),    -- OWNER only
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  EXCLUDE USING gist (crew_role WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE TABLE payroll_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL REFERENCES payroll_periods(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  source text NOT NULL CHECK (source IN ('production','trip','daily','adjustment')),
  ref_id uuid, description text NOT NULL,
  qty numeric(10,2), rate numeric(10,2), amount numeric(12,2) NOT NULL,
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),        -- adjustments need the Owner's approval
  voided_at timestamptz, void_reason text,      -- a wrong line is voided, never deleted; the source can then be paid again
  CHECK (source <> 'adjustment' OR (approved_by IS NOT NULL AND created_by IS NOT NULL AND approved_by <> created_by)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX payroll_line_once ON payroll_lines (source, ref_id, employee_id)
  WHERE ref_id IS NOT NULL AND voided_at IS NULL;   -- no double pay
```

Weekly summary that reproduces your Excel (total, headcount, average, highest, lowest):

```sql
SELECT p.week_no,
       SUM(w.total)                         AS total_weekly_payroll,
       COUNT(*)                             AS no_of_manpower,
       ROUND(AVG(w.total), 2)               AS avg_per_manpower,
       MAX(w.total) AS highest_salary, MIN(w.total) AS lowest_salary
FROM payroll_periods p
JOIN (SELECT period_id, employee_id, SUM(amount) AS total
        FROM payroll_lines WHERE voided_at IS NULL GROUP BY period_id, employee_id) w ON w.period_id = p.id
GROUP BY p.id, p.week_no ORDER BY p.period_start;
```

### 7.8 Procurement, CRM, pallet audit (Phase 2–3, outline)

```sql
CREATE TABLE tickets (                           -- client concerns
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no text UNIQUE NOT NULL DEFAULT next_doc_no('TKT','TKT'),
  client_id uuid REFERENCES clients(id), site_id uuid REFERENCES client_sites(id),
  channel text NOT NULL CHECK (channel IN ('messenger','viber','whatsapp','email','call','visit','portal')),
  category text NOT NULL CHECK (category IN ('delivery','damage_charges','billing','audit','repair','other')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting_client','resolved','closed')),
  subject text NOT NULL, related_dr_id uuid REFERENCES delivery_receipts(id),
  assignee_id uuid REFERENCES users(id), sla_due_at timestamptz,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE TABLE ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL REFERENCES tickets(id),
  direction text NOT NULL CHECK (direction IN ('in','out','internal')), body text NOT NULL,
  file_ids uuid[] NOT NULL DEFAULT '{}', created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pallet_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_no text UNIQUE NOT NULL DEFAULT next_doc_no('AUD','AUD'),
  site_id uuid NOT NULL REFERENCES client_sites(id),
  notice_sent_on date NOT NULL, audit_date date NOT NULL,
  CHECK (audit_date >= notice_sent_on + 5),               -- BR-11 5-day notice
  client_rep_name text, system_qty int, counted_qty int,
  counts_by_condition jsonb,                              -- {"A":120,"B":14,...}
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','counted','approved','void')),
  performed_by uuid REFERENCES users(id), approved_by uuid REFERENCES users(id)
);

-- Phase 3: suppliers, items, purchase_requisitions, purchase_orders (+lines), goods_receipts,
-- stock_movements (item ledger, append-only like pallet_movements), container_shipments, approval_rules.
```

### 7.9 Approvals inbox and notifications

```sql
CREATE TABLE approval_requests (                 -- the approver's "Waiting for me" list
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL, entity_id uuid NOT NULL,
  required_permission text NOT NULL REFERENCES permissions(code),   -- approvers = holders of this permission
  summary text NOT NULL,                         -- e.g. 'Voucher V-123, trip TT-2026-000045, ₱1,500'
  link text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by uuid REFERENCES users(id), decided_at timestamptz, decision_note text,
  reminder_count int NOT NULL DEFAULT 0, last_reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX approval_pending_idx ON approval_requests (required_permission) WHERE status = 'pending';

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL,                            -- 'approval_needed','approval_reminder','dispute_deadline',...
  title text NOT NULL, body text, link text,
  channels text[] NOT NULL DEFAULT '{in_app}',   -- in_app, push, email
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, read_at timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at);
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  endpoint text UNIQUE NOT NULL, keys jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
```

### 7.10 Database roles and row-level security (Phase 3 portal; roles created in Phase 0)

The app connects as `app_user`. Client-portal requests run in a transaction that does `SET LOCAL ROLE app_client` and
`SELECT set_config('app.client_id', :client_id, true)`; Postgres then enforces the client boundary even if an API route
forgets a filter. `app_user` has its own explicit full-access policies, so enabling RLS never locks out the normal app.

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user')   THEN CREATE ROLE app_user LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_client') THEN CREATE ROLE app_client NOLOGIN; END IF;
END $$;
GRANT app_client TO app_user;                    -- lets app_user SET LOCAL ROLE app_client

ALTER TABLE delivery_receipts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_summaries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_orders       ENABLE ROW LEVEL SECURITY;
-- (the table owner / migration role bypasses RLS; app_user and app_client do not)

CREATE POLICY app_full_access ON delivery_receipts FOR ALL TO app_user USING (true) WITH CHECK (true);
CREATE POLICY app_full_access ON billing_summaries FOR ALL TO app_user USING (true) WITH CHECK (true);
CREATE POLICY app_full_access ON sales_orders      FOR ALL TO app_user USING (true) WITH CHECK (true);

-- Clients see only their own rows, and only documents that were actually sent to them.
CREATE POLICY client_own_drs ON delivery_receipts FOR SELECT TO app_client
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid AND status <> 'void');
CREATE POLICY client_own_bs ON billing_summaries FOR SELECT TO app_client
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
         AND status IN ('sent_to_client','client_approved','disputed','exported','invoiced'));
CREATE POLICY client_own_so ON sales_orders FOR SELECT TO app_client
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
         AND status NOT IN ('draft','void'));
GRANT SELECT ON delivery_receipts, billing_summaries, sales_orders TO app_client;
```

If `app.client_id` is not set the policy matches nothing (fail closed). The portal never gets write access by SQL; client
approval and dispute actions go through the API, which checks the same client id.

## 8. Security, roles and permissions

Target: OWASP ASVS Level 2 for the web app. Principle: **deny by default, enforce on the server, log everything that matters.**

### 8.1 Authentication

| Control | Requirement |
|---|---|
| Office users | Username/email + password, **argon2id** (≥19 MiB memory, 2 iterations, 1 lane, per OWASP guidance). Minimum 12 characters; check against a breached-password list; no composition rules. |
| MFA | TOTP **mandatory** for `OWNER`, `ADMIN_IT`, `FINANCE`, `HR`, `BILLING`, `OPS_MGR`, `SALES_MGR`. Recovery codes (hashed). Reset only by `ADMIN_IT` + `OWNER` confirmation. |
| Field users (driver, helper, guard, worker) | Often no email, so **device-bound PIN login**: phone is enrolled once by `ADMIN_IT`/`HR`; 6-digit PIN + enrolled device ID. These roles have narrow permissions (own trips / own counts only), and a PIN session is **technically barred** from every permission marked sensitive (†) in §8.4: money, approvals, exports, rates, user management (enforced in `requirePermission`, §10.3). The guard's two payroll duties (‡: Security sign-off, witnessing the payout) are allowed on a PIN session only within 5 minutes of re-entering the PIN. Office roles can never use PIN login. |
| Brute force | Per-account and per-IP rate limit; 5 failures → exponential lockout (1, 5, 15 min…); generic error messages; failures audited. |
| Sessions | Opaque 256-bit random token in a `__Host-` cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`. Only the SHA-256 hash is stored. Idle timeout 30 min (office), 12 h (enrolled field device). Absolute max 12 h office / 30 days field. Rotate on login and privilege change. Revoke all on password/PIN change. |
| Step-up | Re-enter password/TOTP (valid 10 min) for: payroll approval, payroll reopen, rate changes, role changes, break-glass, exports. Enforced for the permissions in `STEP_UP_PERMISSIONS`. |
| Offboarding | Disabling an employee disables the user and revokes sessions/devices in one action. |

### 8.2 Authorization model

- **RBAC**: users have roles; roles have permissions (`module.action`). Permissions are checked **server-side on every request**. The UI hides buttons, but hiding is cosmetic.
- **Scope (ABAC)**: a permission may be limited by scope: `CLIENT` users only see rows with their `client_id`; `DRIVER`/`HELPER` only their assigned trips; `WORKER` only their own entries/earnings. Scope checks live in the data-access layer, not in the controllers.
- **Defense in depth**: PostgreSQL row-level security for the client portal role (see §7.10). The app connects with a least-privilege DB role (no DDL, no `TRUNCATE`).
- **Admin ≠ approver**: `ADMIN_IT` manages users and settings but holds no business approval permissions.
- **Break-glass**: `OWNER` can reopen a locked payroll period or void a billed document **with a written reason**, step-up auth, and an automatic alert to Finance. Always audited.

### 8.3 Segregation of duties (enforced in code and, where possible, by DB `CHECK`)

| Control | Rule |
|---|---|
| Proposal / sales order | Creator ≠ approver (DB `CHECK` on sales orders) |
| Trip voucher | Requester ≠ approver (`OWNER`) ≠ releaser (`FINANCE`). If the Owner is the requester the voucher is auto-approved, flagged `owner_raised`, and Finance still releases (DB `CHECK`) |
| Production count | Enterer ≠ approver; nobody approves their own pay line |
| Payroll | Computed by the system job (no person); weekly sign-off by Production Officer, HR, Security (each checks quantities and the payout) and Finance; then `OWNER` approval; cash payout by HR witnessed by Security. One person per step (unique per round); a user cannot sign a period in which they are a payee. Sign-offs are given on the frozen total and are void if the period is reopened. HR adjustments need Owner approval. The person who encoded an entry cannot approve it |
| Rates (activity, zone, contract floor) | Only `OWNER`; effective-dated; never retroactive on approved entries |
| Inventory adjustment / reversal | Needs `OPS_MGR`; if the requester is `OPS_MGR`, `OWNER` approves |
| Purchase order (Phase 3) | Creator ≠ approver; thresholds in `approval_rules` |

### 8.4 Permission matrix (generated from §10.2 — do not edit by hand)

✔ = the role holds the permission. † = sensitive (not allowed on a PIN session). ‡ = PIN session allowed only with PIN re-entry.
Scope still applies on top: `CLIENT` sees only its own client's rows; `DRIVER`/`HELPER` only their assigned trips (`trips.own`);
`WORKER` only their own entries and earnings. `payroll.compute` has no human holder: the weekly computation is a system job.

| Permission | Code | OWN | ADM | OPM | SLM | SLS | DEP | AUD | CSR | PUR | HR | BIL | FIN | SUP | GRD | DRV | HLP | WRK | CLI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| View clients and sites | `clients.read` | ✔ |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ |  |  |  |  |  |  |
| Create/edit clients and sites | `clients.write` |  |  |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Accredit a client † | `clients.accredit` |  |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| View proposals and contracts | `proposals.read` | ✔ |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  | ✔ |  |  |  |  |  |  |  |
| Draft proposals | `proposals.write` |  |  |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Approve a proposal † | `proposals.approve` |  |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Send a proposal | `proposals.send` |  |  |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Draft contracts and rate terms | `contracts.write` |  |  |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| View sales orders | `so.read` | ✔ |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ | ✔ |  |  |  |  |  |  |
| Create sales orders | `so.create` |  |  |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Approve sales orders † | `so.approve` |  |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Override the 240-pallet minimum † | `so.override_min_qty` | ✔ |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| View work orders, trips, DR, gate passes | `trips.read` | ✔ |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ |  | ✔ |  |  |  |  |
| Approve work orders and trip plans † | `wo.approve` |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Plan work orders and trips | `trips.write` |  |  | ✔ |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |
| Request a trip voucher | `vouchers.request` | ✔ |  | ✔ |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |
| Approve a voucher (Owner only) † | `trips.approve_budget` | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Release voucher cash † | `trips.release_budget` |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |
| Dispatch a trip | `trips.dispatch` |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |
| Work on own assigned trips | `trips.own` |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ | ✔ |  |  |
| View DR and POD | `dr.read` | ✔ |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ |  |  |  |  |  |  |
| Issue a DR | `dr.issue` |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |
| Record the signed DR as received (app or scanned paper) | `dr.receive` |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  | ✔ | ✔ |  |  |
| Record return receipts and damage classes | `returns.record` |  |  | ✔ |  |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |
| Void a DR † | `dr.void` |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Verify a gate pass at the gate | `gatepass.verify` |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |
| Upload proof-of-delivery photos | `pod.upload` |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  | ✔ | ✔ |  |  |
| View pallet inventory | `inventory.read` | ✔ |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ |  | ✔ |  |  |  |  |
| Request an inventory adjustment | `inventory.adjust` |  |  | ✔ |  |  | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |
| Approve an inventory adjustment † | `inventory.approve` | ✔ |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Record pallet audits | `pallet_audit.write` |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |
| Approve pallet audit results † | `pallet_audit.approve` |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| View billing summaries | `billing.read` | ✔ |  | ✔ | ✔ |  |  |  |  |  |  | ✔ | ✔ |  |  |  |  |  |  |
| Prepare billing summaries | `billing.write` |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |
| Operations review of a billing summary † | `billing.review` |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Export billing data for SAP/Crystal † | `billing.export` |  |  |  |  |  |  |  |  |  |  | ✔ | ✔ |  |  |  |  |  |  |
| View production entries | `production.read` | ✔ |  | ✔ |  |  |  |  |  |  | ✔ |  |  | ✔ | ✔ |  |  |  |  |
| Enter own output (if enabled) | `production.enter_own` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |
| Encode output sheets for workers | `production.enter_for_others` |  |  |  |  |  |  |  |  |  |  |  |  | ✔ | ✔ |  |  |  |  |
| Approve production entries † | `production.approve` |  |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |
| Run the payroll computation (system job only) † | `payroll.compute` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| View payroll periods | `payroll.read` | ✔ |  |  |  |  |  |  |  |  | ✔ |  | ✔ | ✔ | ✔ |  |  |  |  |
| Production Officer sign-off † | `payroll.verify_production` |  |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |
| Security sign-off ‡ | `payroll.verify_security` |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |
| HR sign-off † | `payroll.hr_verify` |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  |
| Finance sign-off † | `payroll.finance_check` |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |
| Owner approval of the period † | `payroll.owner_approve` | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Cash payout (HR) † | `payroll.payout` |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  |
| Witness the cash payout (Security) ‡ | `payroll.witness_payout` |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |
| Propose a payroll adjustment † | `payroll.adjust` |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  |
| Approve a payroll adjustment † | `payroll.adjust_approve` | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Reopen a period before it is paid † | `payroll.reopen` | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| See own earnings | `payroll.read_own` |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ | ✔ | ✔ |  |
| Export payroll † | `payroll.export` |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |
| View rate tables | `rates.read` | ✔ |  | ✔ |  |  | ✔ |  |  |  | ✔ |  | ✔ |  |  |  |  |  |  |
| Change rates (Owner only) † | `rates.manage` | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Create purchase requests/orders | `purchasing.write` |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |  |  |  |
| Approve purchase orders † | `purchasing.approve` |  |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Approve purchase orders above threshold † | `purchasing.approve_high` |  |  |  |  |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |
| Log and handle client concerns | `concerns.write` | ✔ |  |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  | ✔ |  |  |  |  |  |  |  |
| Executive reports | `reports.executive` | ✔ |  | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |  |  |  |  |  |
| Client portal (own client only) | `portal.read` |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | ✔ |
| Manage users, roles, devices † | `users.manage` |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Settings, holidays, numbering † | `settings.manage` |  | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Read the audit log | `auditlog.read` | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Bulk data export † | `exports.any` | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| Void/reopen locked documents with reason † | `admin.break_glass` | ✔ |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

Reading the matrix with the business rules: the Owner approves every voucher (`trips.approve_budget`) and Finance releases
the cash (`trips.release_budget`); an Owner-raised voucher is auto-approved but still needs Finance to release (BR-23). HR can
read production but cannot enter or approve it. Drivers and helpers have no production entry. HR can propose payroll
adjustments but only the Owner approves them. Billing and Finance can both export billing data; Billing prepares, Operations reviews.

### 8.5 Data protection

- **Transport**: HTTPS only, HSTS, TLS 1.2+. Internal DB traffic over TLS.
- **At rest**: encrypted disks/volumes and encrypted object storage; TOTP secrets and any bank/ID fields encrypted at the application layer (AES-256-GCM, key in a secrets manager, rotated). **Do not store government ID or bank account numbers in v1.**
- **Files**: private bucket; access only via **short-lived signed URLs** (≤5 min) issued after a permission check. Allow-list MIME types (JPEG, PNG, PDF), verify magic bytes, size limits (delivery photos ≤2 MB after on-device compression, other images ≤5 MB, PDF ≤15 MB), random storage keys, antivirus scan (ClamAV) before `scan_status='clean'`. Keep original EXIF in the DB row; serve re-encoded derivatives.
- **Web hardening**: strict CSP (no inline scripts), `X-Content-Type-Options`, `frame-ancestors 'none'`, CSRF protection (SameSite + per-session token on mutating requests), output encoding, parameterised queries only, `zod` validation of every request body, upload and query param.
- **API**: rate limits per user/IP, idempotency keys on mutating field-app calls, pagination caps, no stack traces to clients, request IDs in logs.
- **Secrets**: never in the repo; environment/secret manager; separate dev/staging/prod; rotate on staff change.
- **Backups**: nightly encrypted full backup + WAL archiving (target RPO ≤ 1 h, RTO ≤ 4 h); copy kept off the primary provider; **restore tested monthly** and logged.
- **Logging/monitoring**: structured logs (no passwords, PINs, tokens, full photos); alerts for repeated login failures, role changes, exports, break-glass, backup failure. Logs retained ≥ 1 year.
- **Audit trail**: hash-chained `audit_log` (§7.1) written in the same transaction as the change. A nightly job runs `fn_verify_audit_chain()` and alerts on any break.
- **Dependencies**: lockfile, automated dependency audit in CI, pinned base images.

### 8.6 Philippine data privacy

The system holds personal data of employees (names, pay, attendance) and client contacts. The Data Privacy Act of 2012 (RA 10173) applies. Practical consequences: appoint a Data Protection Officer, give employees a privacy notice, keep access need-to-know (the matrix above), set retention periods (e.g. production/payroll lines 5 years — confirm with your accountant/counsel), and have a breach-response procedure. Review the NPC registration/notification requirements with counsel. Electronic signatures on proposals/contracts/DR: confirm acceptable evidence standards with counsel before relying on in-app signatures alone; keep the "upload signed copy" path. Delivery photos carry the crew member's GPS position and time at the moment of capture only; there is no continuous tracking. State this in the employee privacy notice.

### 8.7 Threats this design addresses (abuse cases)

| Abuse case | Control |
|---|---|
| Inflated production counts for pay | Supervisor approval, SoD, above-norm flag, plant-yard reconciliation, rate snapshot, audit trail |
| Fake or reused DR / delivery not made | Gap-free numbers, void-only, QR verification at gate, POD photos with device time, receiver signature |
| Pallets "disappearing" | Append-only ledger, negative-stock block, reversal needs manager, monthly audit variance |
| Budget/voucher leakage | Three-way SoD (request/approve/release), voucher no. unique, liquidation vs actual |
| Rate tampering to under/over-bill | Owner-only effective-dated rates, contract rate snapshot, billing summary immutable once client-approved |
| Insider data export | Export permission separate from read; exports audited and rate-limited; step-up auth |
| Stolen phone of a driver | Device revocation, PIN lockout, narrow scope, short idle timeout |
| Lost admin account | Mandatory MFA, step-up for critical actions, break-glass alerting |

## 9. Architecture and API

**Stack (recommended)**

| Layer | Choice | Why |
|---|---|---|
| App | TypeScript, Next.js (App Router) as one deployable; route handlers = API | One codebase, easy for one developer or an AI-assisted build |
| DB | PostgreSQL 16 | Transactions, constraints, triggers and RLS do real work here |
| Jobs | `pg-boss` (Postgres-backed) | No Redis to run: alerts, renewals, nightly checks, report snapshots |
| Files | S3-compatible object storage, private bucket | Signed URLs, cheap |
| PDF | HTML templates → PDF via headless Chromium | Matches your letterhead; one template per document type |
| Field app | Same web app as an installable **PWA**; IndexedDB queue for offline | Works on cheap Android phones, no app-store step |
| Hosting | One VPS/PaaS in a Singapore region + managed or self-run Postgres | Closest region to the Philippines |

```
repo/
  apps/web/            Next.js app (UI + API routes)
  packages/db/         SQL migrations (numbered), seed, query helpers
  packages/core/       rbac, state machines, billing, payroll, numbering (pure, unit-tested)
  packages/pdf/        templates + renderer
  ops/                 docker-compose, backup scripts, runbooks
```

**Endpoint groups** (all under `/api/v1`, JSON, cookie session, every route declares its permission)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `/auth/mfa/verify`, `/auth/pin-login`, `/auth/logout`, `/auth/devices` |
| Clients | `GET/POST /clients`, `POST /clients/:id/accredit`, `GET/POST /clients/:id/sites` |
| Proposals | `POST /proposals`, `POST /proposals/:id/submit`, `/approve`, `/render-pdf`, `/send`, `/conforme` |
| Contracts | `POST /contracts` (from proposal), `/sign`, `GET /contracts/expiring` |
| Sales orders | `POST /sales-orders`, `/submit`, `/approve`, `/cancel`, `/void` |
| Operations | `POST /work-orders`, `POST /trips`, `/trips/:id/budget/approve`, `/budget/release`, `/dispatch` |
| Documents | `POST /trips/:id/dr`, `/trips/:id/gate-pass`, `GET /verify/:token` (QR) |
| Field (offline) | `POST /sync` (batch of ops with `client_op_id`), `POST /uploads/sign`, `POST /uploads/:id/confirm` |
| Inventory | `GET /inventory/balances`, `POST /inventory/adjustments`, `POST /inventory/reversals` |
| Billing | `POST /billing-summaries/generate`, `/review`, `/send`, `/client-approval`, `/export`, `/invoice-info` |
| Production/payroll | `POST /production-entries`, `/submit`, `/approve`, `POST /payroll/periods/:id/compute`, `/verify`, `/finance-check`, `/approve`, `/export` |
| Tickets | `GET/POST /tickets`, `POST /tickets/:id/messages` |
| Returns | `POST /return-receipts`, `POST /return-receipts/:id/receive` |
| Approvals | `GET /approvals/inbox`, `POST /approvals/:id/approve`, `/reject`, `GET /notifications`, `POST /notifications/:id/read`, `POST /push/subscribe` |
| Admin | `GET/POST /users`, `/roles`, `/settings`, `GET /audit-log` |

## 10. Reference code

These are **reference implementations** of the security-critical and business-critical pieces. They show intent and shape; run them under tests (§15) before relying on them.

### 10.1 Seed: roles and permissions

The audit-chain verifier lives with its table in §7.1 (`fn_verify_audit_chain`, built on the same `audit_row_hash` the trigger uses).
The permission rows below are **generated from the one catalog in §10.2**; do not edit them by hand.

```sql
INSERT INTO roles (code, name, requires_mfa, is_system) VALUES
  ('OWNER','President & CEO',true,true), ('ADMIN_IT','IT & QA Officer',true,true),
  ('OPS_MGR','Pallet Operations Manager',true,true), ('SALES_MGR','Sales Manager',true,true),
  ('SALES','Sales',false,true), ('DEPLOY','Deployment Officer',false,true),
  ('AUDITOR','Pallet Auditor',false,true), ('CSR_REPAIR','CSR Repair',false,true),
  ('PURCHASING','Purchasing',false,true), ('HR','HR & QA',true,true), ('BILLING','Billing',true,true),
  ('FINANCE','Finance',true,true), ('SUPERVISOR','Production Supervisor/QC',false,true),
  ('GUARD','Security Guard',false,true), ('DRIVER','Driver',false,true), ('HELPER','Helper',false,true),
  ('WORKER','Pallet Maker/Painter',false,true), ('CLIENT','Client Portal',false,true);

ALTER TABLE permissions ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'normal'
  CHECK (sensitivity IN ('normal','sensitive','pin_stepup'));
INSERT INTO permissions (code, description, sensitivity) VALUES
  ('clients.read','View clients and sites','normal'),
  ('clients.write','Create/edit clients and sites','normal'),
  ('clients.accredit','Accredit a client','sensitive'),
  ('proposals.read','View proposals and contracts','normal'),
  ('proposals.write','Draft proposals','normal'),
  ('proposals.approve','Approve a proposal','sensitive'),
  ('proposals.send','Send a proposal','normal'),
  ('contracts.write','Draft contracts and rate terms','normal'),
  ('so.read','View sales orders','normal'),
  ('so.create','Create sales orders','normal'),
  ('so.approve','Approve sales orders','sensitive'),
  ('so.override_min_qty','Override the 240-pallet minimum','sensitive'),
  ('trips.read','View work orders, trips, DR, gate passes','normal'),
  ('wo.approve','Approve work orders and trip plans','sensitive'),
  ('trips.write','Plan work orders and trips','normal'),
  ('vouchers.request','Request a trip voucher','normal'),
  ('trips.approve_budget','Approve a voucher (Owner only)','sensitive'),
  ('trips.release_budget','Release voucher cash','sensitive'),
  ('trips.dispatch','Dispatch a trip','normal'),
  ('trips.own','Work on own assigned trips','normal'),
  ('dr.read','View DR and POD','normal'),
  ('dr.issue','Issue a DR','normal'),
  ('dr.receive','Record the signed DR as received (app or scanned paper)','normal'),
  ('returns.record','Record return receipts and damage classes','normal'),
  ('dr.void','Void a DR','sensitive'),
  ('gatepass.verify','Verify a gate pass at the gate','normal'),
  ('pod.upload','Upload proof-of-delivery photos','normal'),
  ('inventory.read','View pallet inventory','normal'),
  ('inventory.adjust','Request an inventory adjustment','normal'),
  ('inventory.approve','Approve an inventory adjustment','sensitive'),
  ('pallet_audit.write','Record pallet audits','normal'),
  ('pallet_audit.approve','Approve pallet audit results','sensitive'),
  ('billing.read','View billing summaries','normal'),
  ('billing.write','Prepare billing summaries','normal'),
  ('billing.review','Operations review of a billing summary','sensitive'),
  ('billing.export','Export billing data for SAP/Crystal','sensitive'),
  ('production.read','View production entries','normal'),
  ('production.enter_own','Enter own output (if enabled)','normal'),
  ('production.enter_for_others','Encode output sheets for workers','normal'),
  ('production.approve','Approve production entries','sensitive'),
  ('payroll.compute','Run the payroll computation (system job only)','sensitive'),
  ('payroll.read','View payroll periods','normal'),
  ('payroll.verify_production','Production Officer sign-off','sensitive'),
  ('payroll.verify_security','Security sign-off','pin_stepup'),
  ('payroll.hr_verify','HR sign-off','sensitive'),
  ('payroll.finance_check','Finance sign-off','sensitive'),
  ('payroll.owner_approve','Owner approval of the period','sensitive'),
  ('payroll.payout','Cash payout (HR)','sensitive'),
  ('payroll.witness_payout','Witness the cash payout (Security)','pin_stepup'),
  ('payroll.adjust','Propose a payroll adjustment','sensitive'),
  ('payroll.adjust_approve','Approve a payroll adjustment','sensitive'),
  ('payroll.reopen','Reopen a period before it is paid','sensitive'),
  ('payroll.read_own','See own earnings','normal'),
  ('payroll.export','Export payroll','sensitive'),
  ('rates.read','View rate tables','normal'),
  ('rates.manage','Change rates (Owner only)','sensitive'),
  ('purchasing.write','Create purchase requests/orders','normal'),
  ('purchasing.approve','Approve purchase orders','sensitive'),
  ('purchasing.approve_high','Approve purchase orders above threshold','sensitive'),
  ('concerns.write','Log and handle client concerns','normal'),
  ('reports.executive','Executive reports','normal'),
  ('portal.read','Client portal (own client only)','normal'),
  ('users.manage','Manage users, roles, devices','sensitive'),
  ('settings.manage','Settings, holidays, numbering','sensitive'),
  ('auditlog.read','Read the audit log','normal'),
  ('exports.any','Bulk data export','sensitive'),
  ('admin.break_glass','Void/reopen locked documents with reason','sensitive');
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, v.p FROM (VALUES
  ('OWNER','clients.read'),
  ('OPS_MGR','clients.read'),
  ('SALES_MGR','clients.read'),
  ('SALES','clients.read'),
  ('DEPLOY','clients.read'),
  ('AUDITOR','clients.read'),
  ('CSR_REPAIR','clients.read'),
  ('BILLING','clients.read'),
  ('FINANCE','clients.read'),
  ('SALES_MGR','clients.write'),
  ('SALES','clients.write'),
  ('SALES_MGR','clients.accredit'),
  ('OWNER','proposals.read'),
  ('OPS_MGR','proposals.read'),
  ('SALES_MGR','proposals.read'),
  ('SALES','proposals.read'),
  ('DEPLOY','proposals.read'),
  ('BILLING','proposals.read'),
  ('SALES_MGR','proposals.write'),
  ('SALES','proposals.write'),
  ('SALES_MGR','proposals.approve'),
  ('SALES_MGR','proposals.send'),
  ('SALES','proposals.send'),
  ('SALES_MGR','contracts.write'),
  ('SALES','contracts.write'),
  ('OWNER','so.read'),
  ('OPS_MGR','so.read'),
  ('SALES_MGR','so.read'),
  ('SALES','so.read'),
  ('DEPLOY','so.read'),
  ('AUDITOR','so.read'),
  ('BILLING','so.read'),
  ('FINANCE','so.read'),
  ('SALES_MGR','so.create'),
  ('SALES','so.create'),
  ('SALES_MGR','so.approve'),
  ('OWNER','so.override_min_qty'),
  ('SALES_MGR','so.override_min_qty'),
  ('OWNER','trips.read'),
  ('OPS_MGR','trips.read'),
  ('SALES_MGR','trips.read'),
  ('SALES','trips.read'),
  ('DEPLOY','trips.read'),
  ('AUDITOR','trips.read'),
  ('CSR_REPAIR','trips.read'),
  ('BILLING','trips.read'),
  ('FINANCE','trips.read'),
  ('GUARD','trips.read'),
  ('OPS_MGR','wo.approve'),
  ('OPS_MGR','trips.write'),
  ('DEPLOY','trips.write'),
  ('OWNER','vouchers.request'),
  ('OPS_MGR','vouchers.request'),
  ('DEPLOY','vouchers.request'),
  ('OWNER','trips.approve_budget'),
  ('FINANCE','trips.release_budget'),
  ('DEPLOY','trips.dispatch'),
  ('DRIVER','trips.own'),
  ('HELPER','trips.own'),
  ('OWNER','dr.read'),
  ('OPS_MGR','dr.read'),
  ('SALES_MGR','dr.read'),
  ('SALES','dr.read'),
  ('DEPLOY','dr.read'),
  ('AUDITOR','dr.read'),
  ('CSR_REPAIR','dr.read'),
  ('BILLING','dr.read'),
  ('FINANCE','dr.read'),
  ('DEPLOY','dr.issue'),
  ('DRIVER','dr.receive'),
  ('HELPER','dr.receive'),
  ('DEPLOY','dr.receive'),
  ('OPS_MGR','returns.record'),
  ('DEPLOY','returns.record'),
  ('AUDITOR','returns.record'),
  ('OPS_MGR','dr.void'),
  ('GUARD','gatepass.verify'),
  ('DRIVER','pod.upload'),
  ('HELPER','pod.upload'),
  ('DEPLOY','pod.upload'),
  ('OWNER','inventory.read'),
  ('OPS_MGR','inventory.read'),
  ('SALES_MGR','inventory.read'),
  ('SALES','inventory.read'),
  ('DEPLOY','inventory.read'),
  ('AUDITOR','inventory.read'),
  ('CSR_REPAIR','inventory.read'),
  ('BILLING','inventory.read'),
  ('FINANCE','inventory.read'),
  ('GUARD','inventory.read'),
  ('OPS_MGR','inventory.adjust'),
  ('DEPLOY','inventory.adjust'),
  ('AUDITOR','inventory.adjust'),
  ('OWNER','inventory.approve'),
  ('OPS_MGR','inventory.approve'),
  ('AUDITOR','pallet_audit.write'),
  ('OPS_MGR','pallet_audit.approve'),
  ('OWNER','billing.read'),
  ('OPS_MGR','billing.read'),
  ('SALES_MGR','billing.read'),
  ('BILLING','billing.read'),
  ('FINANCE','billing.read'),
  ('BILLING','billing.write'),
  ('OPS_MGR','billing.review'),
  ('BILLING','billing.export'),
  ('FINANCE','billing.export'),
  ('OWNER','production.read'),
  ('OPS_MGR','production.read'),
  ('HR','production.read'),
  ('SUPERVISOR','production.read'),
  ('GUARD','production.read'),
  ('WORKER','production.enter_own'),
  ('SUPERVISOR','production.enter_for_others'),
  ('GUARD','production.enter_for_others'),
  ('SUPERVISOR','production.approve'),
  ('OWNER','payroll.read'),
  ('HR','payroll.read'),
  ('FINANCE','payroll.read'),
  ('SUPERVISOR','payroll.read'),
  ('GUARD','payroll.read'),
  ('SUPERVISOR','payroll.verify_production'),
  ('GUARD','payroll.verify_security'),
  ('HR','payroll.hr_verify'),
  ('FINANCE','payroll.finance_check'),
  ('OWNER','payroll.owner_approve'),
  ('HR','payroll.payout'),
  ('GUARD','payroll.witness_payout'),
  ('HR','payroll.adjust'),
  ('OWNER','payroll.adjust_approve'),
  ('OWNER','payroll.reopen'),
  ('DRIVER','payroll.read_own'),
  ('HELPER','payroll.read_own'),
  ('WORKER','payroll.read_own'),
  ('FINANCE','payroll.export'),
  ('OWNER','rates.read'),
  ('OPS_MGR','rates.read'),
  ('DEPLOY','rates.read'),
  ('HR','rates.read'),
  ('FINANCE','rates.read'),
  ('OWNER','rates.manage'),
  ('PURCHASING','purchasing.write'),
  ('OPS_MGR','purchasing.approve'),
  ('FINANCE','purchasing.approve_high'),
  ('OWNER','concerns.write'),
  ('SALES_MGR','concerns.write'),
  ('SALES','concerns.write'),
  ('DEPLOY','concerns.write'),
  ('AUDITOR','concerns.write'),
  ('CSR_REPAIR','concerns.write'),
  ('BILLING','concerns.write'),
  ('OWNER','reports.executive'),
  ('OPS_MGR','reports.executive'),
  ('SALES_MGR','reports.executive'),
  ('FINANCE','reports.executive'),
  ('CLIENT','portal.read'),
  ('ADMIN_IT','users.manage'),
  ('ADMIN_IT','settings.manage'),
  ('OWNER','auditlog.read'),
  ('ADMIN_IT','auditlog.read'),
  ('OWNER','exports.any'),
  ('OWNER','admin.break_glass')
) AS v(role, p) JOIN roles r ON r.code = v.role;
```

### 10.2 Permissions and role mapping — the single catalog (`packages/core/rbac.ts`)

This catalog is the **only** place permissions are defined. The `P` constants, `ROLE_PERMISSIONS`, the §10.1 SQL seed and the
§8.4 matrix are all generated from it (`pnpm gen:rbac`); CI fails if any generated copy differs from the catalog. Each
permission has a sensitivity: `normal`; `sensitive` (money, approvals, exports, rates, user management — never allowed on a
PIN session, see §8.1); `pin_stepup` (the two guard duties on payroll — allowed on a PIN session only after PIN re-entry).

```ts
// GENERATED from the catalog in §10.2 — do not hand-edit the role lists; edit the catalog and regenerate (CI checks §8.4 and the seed match).
export const PERMISSIONS = [
  // clients & commercial
  { key: 'CLIENT_READ', code: 'clients.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING', 'FINANCE'] },
  { key: 'CLIENT_WRITE', code: 'clients.write', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  { key: 'CLIENT_ACCREDIT', code: 'clients.accredit', sensitivity: 'sensitive', roles: ['SALES_MGR'] },
  { key: 'PROPOSAL_READ', code: 'proposals.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'BILLING'] },
  { key: 'PROPOSAL_WRITE', code: 'proposals.write', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  { key: 'PROPOSAL_APPROVE', code: 'proposals.approve', sensitivity: 'sensitive', roles: ['SALES_MGR'] },
  { key: 'PROPOSAL_SEND', code: 'proposals.send', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  { key: 'CONTRACT_WRITE', code: 'contracts.write', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  // orders & delivery
  { key: 'SO_READ', code: 'so.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'BILLING', 'FINANCE'] },
  { key: 'SO_CREATE', code: 'so.create', sensitivity: 'normal', roles: ['SALES_MGR', 'SALES'] },
  { key: 'SO_APPROVE', code: 'so.approve', sensitivity: 'sensitive', roles: ['SALES_MGR'] },
  { key: 'SO_OVERRIDE_MIN', code: 'so.override_min_qty', sensitivity: 'sensitive', roles: ['OWNER', 'SALES_MGR'] },
  { key: 'TRIP_READ', code: 'trips.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING', 'FINANCE', 'GUARD'] },
  { key: 'WO_APPROVE', code: 'wo.approve', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'TRIP_WRITE', code: 'trips.write', sensitivity: 'normal', roles: ['OPS_MGR', 'DEPLOY'] },
  { key: 'VOUCHER_REQUEST', code: 'vouchers.request', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'DEPLOY'] },
  { key: 'TRIP_APPROVE_BUDGET', code: 'trips.approve_budget', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'TRIP_RELEASE_BUDGET', code: 'trips.release_budget', sensitivity: 'sensitive', roles: ['FINANCE'] },
  { key: 'TRIP_DISPATCH', code: 'trips.dispatch', sensitivity: 'normal', roles: ['DEPLOY'] },
  { key: 'TRIP_OWN', code: 'trips.own', sensitivity: 'normal', roles: ['DRIVER', 'HELPER'] },
  { key: 'DR_READ', code: 'dr.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING', 'FINANCE'] },
  { key: 'DR_ISSUE', code: 'dr.issue', sensitivity: 'normal', roles: ['DEPLOY'] },
  { key: 'DR_RECEIVE', code: 'dr.receive', sensitivity: 'normal', roles: ['DRIVER', 'HELPER', 'DEPLOY'] },
  { key: 'RETURN_RECORD', code: 'returns.record', sensitivity: 'normal', roles: ['OPS_MGR', 'DEPLOY', 'AUDITOR'] },
  { key: 'DR_VOID', code: 'dr.void', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'GATEPASS_VERIFY', code: 'gatepass.verify', sensitivity: 'normal', roles: ['GUARD'] },
  { key: 'POD_UPLOAD', code: 'pod.upload', sensitivity: 'normal', roles: ['DRIVER', 'HELPER', 'DEPLOY'] },
  // inventory, audit & billing
  { key: 'INV_READ', code: 'inventory.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING', 'FINANCE', 'GUARD'] },
  { key: 'INV_ADJUST', code: 'inventory.adjust', sensitivity: 'normal', roles: ['OPS_MGR', 'DEPLOY', 'AUDITOR'] },
  { key: 'INV_APPROVE', code: 'inventory.approve', sensitivity: 'sensitive', roles: ['OWNER', 'OPS_MGR'] },
  { key: 'AUDIT_WRITE', code: 'pallet_audit.write', sensitivity: 'normal', roles: ['AUDITOR'] },
  { key: 'AUDIT_APPROVE', code: 'pallet_audit.approve', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'BILL_READ', code: 'billing.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'BILLING', 'FINANCE'] },
  { key: 'BILL_WRITE', code: 'billing.write', sensitivity: 'normal', roles: ['BILLING'] },
  { key: 'BILL_REVIEW', code: 'billing.review', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'BILL_EXPORT', code: 'billing.export', sensitivity: 'sensitive', roles: ['BILLING', 'FINANCE'] },
  // production & payroll
  { key: 'PROD_READ', code: 'production.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'HR', 'SUPERVISOR', 'GUARD'] },
  { key: 'PROD_ENTER_OWN', code: 'production.enter_own', sensitivity: 'normal', roles: ['WORKER'] },
  { key: 'PROD_ENTER_FOR', code: 'production.enter_for_others', sensitivity: 'normal', roles: ['SUPERVISOR', 'GUARD'] },
  { key: 'PROD_APPROVE', code: 'production.approve', sensitivity: 'sensitive', roles: ['SUPERVISOR'] },
  { key: 'PAY_COMPUTE', code: 'payroll.compute', sensitivity: 'sensitive', roles: [] },
  { key: 'PAY_READ', code: 'payroll.read', sensitivity: 'normal', roles: ['OWNER', 'HR', 'FINANCE', 'SUPERVISOR', 'GUARD'] },
  { key: 'PAY_PROD_VERIFY', code: 'payroll.verify_production', sensitivity: 'sensitive', roles: ['SUPERVISOR'] },
  { key: 'PAY_SEC_VERIFY', code: 'payroll.verify_security', sensitivity: 'pin_stepup', roles: ['GUARD'] },
  { key: 'PAY_HR_VERIFY', code: 'payroll.hr_verify', sensitivity: 'sensitive', roles: ['HR'] },
  { key: 'PAY_FIN_CHECK', code: 'payroll.finance_check', sensitivity: 'sensitive', roles: ['FINANCE'] },
  { key: 'PAY_OWNER_APPROVE', code: 'payroll.owner_approve', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'PAY_PAYOUT', code: 'payroll.payout', sensitivity: 'sensitive', roles: ['HR'] },
  { key: 'PAY_WITNESS', code: 'payroll.witness_payout', sensitivity: 'pin_stepup', roles: ['GUARD'] },
  { key: 'PAY_ADJUST', code: 'payroll.adjust', sensitivity: 'sensitive', roles: ['HR'] },
  { key: 'PAY_ADJUST_APPROVE', code: 'payroll.adjust_approve', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'PAY_REOPEN', code: 'payroll.reopen', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'PAY_READ_OWN', code: 'payroll.read_own', sensitivity: 'normal', roles: ['DRIVER', 'HELPER', 'WORKER'] },
  { key: 'PAY_EXPORT', code: 'payroll.export', sensitivity: 'sensitive', roles: ['FINANCE'] },
  { key: 'RATES_READ', code: 'rates.read', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'DEPLOY', 'HR', 'FINANCE'] },
  { key: 'RATES_MANAGE', code: 'rates.manage', sensitivity: 'sensitive', roles: ['OWNER'] },
  // procurement, concerns, reports (Phase 2-3)
  { key: 'PO_WRITE', code: 'purchasing.write', sensitivity: 'normal', roles: ['PURCHASING'] },
  { key: 'PO_APPROVE', code: 'purchasing.approve', sensitivity: 'sensitive', roles: ['OPS_MGR'] },
  { key: 'PO_APPROVE_HIGH', code: 'purchasing.approve_high', sensitivity: 'sensitive', roles: ['FINANCE'] },
  { key: 'CONCERN_WRITE', code: 'concerns.write', sensitivity: 'normal', roles: ['OWNER', 'SALES_MGR', 'SALES', 'DEPLOY', 'AUDITOR', 'CSR_REPAIR', 'BILLING'] },
  { key: 'REPORT_EXEC', code: 'reports.executive', sensitivity: 'normal', roles: ['OWNER', 'OPS_MGR', 'SALES_MGR', 'FINANCE'] },
  { key: 'PORTAL_READ', code: 'portal.read', sensitivity: 'normal', roles: ['CLIENT'] },
  // admin
  { key: 'USERS_MANAGE', code: 'users.manage', sensitivity: 'sensitive', roles: ['ADMIN_IT'] },
  { key: 'SETTINGS', code: 'settings.manage', sensitivity: 'sensitive', roles: ['ADMIN_IT'] },
  { key: 'AUDIT_READ', code: 'auditlog.read', sensitivity: 'normal', roles: ['OWNER', 'ADMIN_IT'] },
  { key: 'EXPORT_ANY', code: 'exports.any', sensitivity: 'sensitive', roles: ['OWNER'] },
  { key: 'BREAK_GLASS', code: 'admin.break_glass', sensitivity: 'sensitive', roles: ['OWNER'] },
] as const;
export type Permission = (typeof PERMISSIONS)[number]['code'];
export const P = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p.code])) as {
  [K in (typeof PERMISSIONS)[number] as K['key']]: K['code'];
};
export const ROLE_PERMISSIONS: Record<string, Permission[]> = {};
for (const p of PERMISSIONS) for (const r of p.roles) (ROLE_PERMISSIONS[r] ??= []).push(p.code);
export const SENSITIVE = new Set<Permission>(PERMISSIONS.filter((p) => p.sensitivity === 'sensitive').map((p) => p.code));
export const PIN_STEPUP = new Set<Permission>(PERMISSIONS.filter((p) => p.sensitivity === 'pin_stepup').map((p) => p.code));
// Tests: ADMIN_IT holds no *.approve; only OWNER holds rates.manage; PAY_COMPUTE has no human role;
// no role holds both payroll.verify_* and payroll.payout; every code here appears in the seed and in §8.4.
```

### 10.3 Authorization guard and segregation-of-duties helper

```ts
import type { NextRequest } from 'next/server';
import { ROLE_PERMISSIONS, SENSITIVE, PIN_STEPUP, Permission } from './rbac';

export interface Actor {
  id: string; roles: string[]; employeeId?: string; clientScope?: string;
  authMethod: 'password' | 'pin';          // office users sign in with password + TOTP; field users with a device-bound PIN
  mfaPassed: boolean;
  lastStepUpAt?: Date;                     // password/TOTP re-entry (office)
  lastPinReentryAt?: Date;                 // PIN re-entry (field)
}

export class Forbidden extends Error { status = 403 }

export function can(actor: Actor, perm: Permission): boolean {
  return actor.roles.some((r) => ROLE_PERMISSIONS[r]?.includes(perm));
}

const MINUTES = 60_000;
const fresh = (d: Date | undefined, min: number) => !!d && Date.now() - d.getTime() <= min * MINUTES;

export function requirePermission(actor: Actor, perm: Permission, opts: { stepUp?: boolean } = {}): void {
  if (!can(actor, perm)) throw new Forbidden(`missing ${perm}`);

  if (actor.authMethod === 'pin') {
    // A stolen phone + PIN must never reach money, approvals, exports, rates or user management (§8.1).
    if (SENSITIVE.has(perm)) throw new Forbidden(`${perm} is not allowed on a PIN session`);
    // The guard's two payroll duties are allowed on a PIN session only right after re-entering the PIN.
    if (PIN_STEPUP.has(perm) && !fresh(actor.lastPinReentryAt, 5)) throw new Forbidden('re-enter your PIN');
  } else {
    if (actor.roles.some((r) => MFA_ROLES.has(r)) && !actor.mfaPassed) throw new Forbidden('mfa required');
    if ((opts.stepUp || STEP_UP_PERMISSIONS.has(perm)) && !fresh(actor.lastStepUpAt, 10)) throw new Forbidden('step-up required');
  }
}

/** BR-21: the approver must not be the creator or the payee. */
export function assertNotSelf(actor: Actor, ...involved: Array<string | null | undefined>): void {
  if (involved.some((id) => id && (id === actor.id || id === actor.employeeId))) {
    throw new Forbidden('segregation of duties: you cannot approve your own record');
  }
}

// Route wrapper: every handler declares its permission, so a missing check fails code review and tests.
export function route(perm: Permission, handler: (req: NextRequest, actor: Actor) => Promise<Response>) {
  return async (req: NextRequest) => {
    const actor = await loadActorFromSession(req);          // 401 if none
    requirePermission(actor, perm);
    return handler(req, actor);
  };
}
declare const MFA_ROLES: Set<string>;
declare const STEP_UP_PERMISSIONS: Set<Permission>;          // payroll approval, rates, role changes, break-glass, large exports (§8.1)
declare function loadActorFromSession(req: NextRequest): Promise<Actor>;
```

### 10.4 State machine with permission per transition (`packages/core/trip.ts`)

The path depends on the trip type. A **client pickup** (the client's own truck loads at the plant) has no RPPC fuel/toll
budget, so it has no voucher step (BR-26); the voucher steps exist only when `trips.voucher_required` is true.

```ts
import { P, Permission } from './rbac';

export type TripType = 'delivery' | 'pickup' | 'return' | 'internal';
export type TripStatus = 'planned' | 'budget_approved' | 'budget_released' | 'loading' | 'dispatched'
  | 'at_site' | 'delivered' | 'returned' | 'closed' | 'cancelled';
type Transitions = Record<TripStatus, Partial<Record<TripStatus, Permission>>>;

const WITH_VOUCHER: Transitions = {
  planned:         { budget_approved: P.TRIP_APPROVE_BUDGET, cancelled: P.TRIP_WRITE },
  budget_approved: { budget_released: P.TRIP_RELEASE_BUDGET, cancelled: P.TRIP_WRITE },
  budget_released: { loading: P.TRIP_DISPATCH, cancelled: P.TRIP_WRITE },
  loading:         { dispatched: P.GATEPASS_VERIFY },          // guard verifies the gate pass at the gate
  dispatched:      { at_site: P.TRIP_OWN },
  at_site:         { delivered: P.TRIP_OWN },
  delivered:       { returned: P.TRIP_OWN },
  returned:        { closed: P.TRIP_WRITE },
  closed: {}, cancelled: {},
};
const NO_VOUCHER_PICKUP: Transitions = {
  planned:         { loading: P.TRIP_DISPATCH, cancelled: P.TRIP_WRITE },
  budget_approved: {}, budget_released: {},
  loading:         { dispatched: P.GATEPASS_VERIFY },
  dispatched:      { delivered: P.DR_RECEIVE },                // Deployment Officer records the client's signed DR at the plant
  at_site: {}, returned: {},
  delivered:       { closed: P.TRIP_WRITE },
  closed: {}, cancelled: {},
};
export const transitionsFor = (t: TripType): Transitions => (t === 'pickup' ? NO_VOUCHER_PICKUP : WITH_VOUCHER);

export interface TripLineQty { palletTypeId: string; condition: string; qtyLoaded: number }
export interface DispatchContext {
  hasTicket: boolean; voucherRequired: boolean; voucherReleased: boolean; drIssued: boolean; gatePassIssued: boolean;
  lines: TripLineQty[]; truckCapacity: number;
}

/** BR-03 / BR-04 / BR-26. Capacity is checked on the total of all lines. */
export function assertCanDispatch(c: DispatchContext): void {
  const total = c.lines.reduce((s, l) => s + l.qtyLoaded, 0);
  if (total <= 0) throw new Error('nothing loaded');
  if (total > c.truckCapacity) throw new Error(`load ${total} exceeds truck capacity ${c.truckCapacity}`);
  const missing = [
    !c.hasTicket && 'trip ticket', c.voucherRequired && !c.voucherReleased && 'released voucher',
    !c.drIssued && 'delivery receipt', !c.gatePassIssued && 'gate pass',
  ].filter(Boolean);
  if (missing.length) throw new Error(`cannot dispatch, missing: ${missing.join(', ')}`);
}

export interface PodEvidence {
  loadedPhotos: number; unloadedPhotos: number; photosMissingGeoOrTime: number;
  receiverName?: string; hasSignature: boolean;
  timeIn?: Date; timeOut?: Date;
}
/** BR-20 (minimums from settings: pod.min_loaded_photos, pod.min_unloaded_photos; default 1 each, max 2).
 *  A client pickup is handed over at the plant: it needs loaded photos, receiver and signature, but no site time-in/out or unloading photos. */
export function assertPodComplete(e: PodEvidence, tripType: TripType, min = { loaded: 1, unloaded: 1 }): void {
  const pickup = tripType === 'pickup';
  const gaps = [
    e.loadedPhotos < min.loaded && `loaded photos (${e.loadedPhotos}/${min.loaded})`,
    !pickup && e.unloadedPhotos < min.unloaded && `unloaded photos (${e.unloadedPhotos}/${min.unloaded})`,
    e.photosMissingGeoOrTime > 0 && `${e.photosMissingGeoOrTime} photo(s) without GPS or timestamp`,
    !e.receiverName && 'receiver name', !e.hasSignature && 'signature',
    !pickup && !e.timeIn && 'time-in', !pickup && !e.timeOut && 'time-out',
  ].filter(Boolean);
  if (gaps.length) throw new Error(`proof of delivery incomplete: ${gaps.join(', ')}`);
}
```

### 10.5 Posting a delivery to the ledger

Every movement into or out of `in_transit` carries the `trip_id`, and a trip can have several type/condition lines, so each
line is posted separately and one truck's pallets can never be unloaded by another.

```ts
const MOVE = `INSERT INTO pallet_movements
  (occurred_at, pallet_type_id, condition, qty, from_location_id, to_location_id, ref_type, ref_id, trip_id, created_by)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;

// Guard verifies the gate pass (trip → dispatched): pallets leave the plant but are NOT billable yet (BR-14).
export async function postDispatch(tx: Tx, trip: TripRow, actor: Actor) {
  const { rows } = await tx.query<LineRow>(`SELECT * FROM trip_lines WHERE trip_id=$1 AND qty_loaded > 0`, [trip.id]);
  for (const l of rows) {
    await tx.query(MOVE, [new Date(), l.palletTypeId, l.condition, l.qtyLoaded,
      PLANT_LOCATION_ID, IN_TRANSIT_LOCATION_ID, 'trip', trip.id, trip.id, actor.id]);
  }
}

// Called in ONE transaction when the signed DR is received at the client site (BR-06, BR-14, BR-20).
// Rent starts at dr.receivedAt. Any shortfall (loaded − delivered) goes back in_transit → plant.
export async function postDelivery(tx: Tx, trip: TripRow, dr: DrRow, actor: Actor) {
  assertPodComplete(await loadPodEvidence(tx, trip.id), trip.tripType as TripType);
  const { rows } = await tx.query<LineRow>(`SELECT * FROM trip_lines WHERE trip_id=$1 FOR UPDATE`, [trip.id]);
  for (const l of rows) {
    const delivered = l.qtyDelivered ?? 0, short = (l.qtyLoaded ?? 0) - delivered;
    if (delivered > 0) {   // the DB guard rejects it if THIS truck holds fewer pallets than delivered
      await tx.query(MOVE, [dr.receivedAt, l.palletTypeId, l.condition, delivered,
        IN_TRANSIT_LOCATION_ID, dr.siteLocationId, 'delivery_receipt', dr.id, trip.id, actor.id]);
    }
    if (short > 0) {
      await tx.query(MOVE, [dr.receivedAt, l.palletTypeId, l.condition, short,
        IN_TRANSIT_LOCATION_ID, PLANT_LOCATION_ID, 'trip_shortfall', trip.id, trip.id, actor.id]);
    }
  }
  await tx.query(`UPDATE delivery_receipts SET status='received', delivered_at=$2, received_at=$3 WHERE id=$1`,
    [dr.id, trip.deliveredAt, dr.receivedAt]);
  await tx.query(`UPDATE trips SET completed_at=$2 WHERE id=$1 AND completed_at IS NULL`, [trip.id, dr.receivedAt]);
  await audit(tx, actor, 'dr.received', 'delivery_receipt', dr.id, null, { lines: rows.length });
}

// Client pickup (BR-26): the client's own truck leaves with the pallets, so there is no in_transit stage.
// The signed DR is handed over at the plant; rent starts at dr.receivedAt.
export async function postPickupHandover(tx: Tx, trip: TripRow, dr: DrRow, actor: Actor) {
  assertPodComplete(await loadPodEvidence(tx, trip.id), 'pickup');
  const { rows } = await tx.query<LineRow>(`SELECT * FROM trip_lines WHERE trip_id=$1 FOR UPDATE`, [trip.id]);
  for (const l of rows) {
    await tx.query(MOVE, [dr.receivedAt, l.palletTypeId, l.condition, l.qtyLoaded ?? 0,
      PLANT_LOCATION_ID, dr.siteLocationId, 'delivery_receipt', dr.id, trip.id, actor.id]);
  }
  await tx.query(`UPDATE delivery_receipts SET status='received', delivered_at=$2, received_at=$2 WHERE id=$1`, [dr.id, dr.receivedAt]);
  await tx.query(`UPDATE trips SET completed_at=$2 WHERE id=$1 AND completed_at IS NULL`, [trip.id, dr.receivedAt]);
  await audit(tx, actor, 'dr.received_pickup', 'delivery_receipt', dr.id, null, { lines: rows.length });
}
```

The client-portal row-level security policies are in §7.10.

### 10.6 Offline field sync (idempotent) and secure uploads

```ts
// Driver phone queues operations while offline; each has a client-generated UUID.
const SyncOp = z.object({
  client_op_id: z.string().uuid(),
  type: z.enum(['trip_event', 'pod_photo_ref', 'receiver_signature']),
  trip_id: z.string().uuid(),
  payload: z.record(z.unknown()),
  device_at: z.string().datetime(),
});

export const POST = route(P.TRIP_OWN, async (req, actor) => {
  const ops = z.array(SyncOp).max(100).parse(await req.json());
  const results = [];
  for (const op of ops) {
    await assertTripAssignedTo(actor, op.trip_id);                 // scope: own trips only
    results.push(await db.tx(async (tx) => {
      const seen = await tx.query('SELECT result FROM processed_ops WHERE client_op_id=$1', [op.client_op_id]);
      if (seen.rowCount) return seen.rows[0].result;                // replay: same answer, no double effect
      const result = await applyOp(tx, actor, op);
      await tx.query('INSERT INTO processed_ops (client_op_id, user_id, result) VALUES ($1,$2,$3)',
        [op.client_op_id, actor.id, result]);
      return result;
    }));
  }
  return Response.json({ results });
});
// processed_ops(client_op_id uuid PRIMARY KEY, user_id uuid NOT NULL, result jsonb, created_at timestamptz DEFAULT now())

// Photo upload: 1) ask for a signed PUT URL, 2) upload directly, 3) confirm with hash; server verifies size, magic bytes, virus scan.
export const signUpload = route(P.POD_UPLOAD, async (req, actor) => {
  const { trip_id, stage, mime, size, sha256, lat, lng, taken_at } = UploadReq.parse(await req.json());
  if (!['image/jpeg', 'image/png'].includes(mime) || size > 2 * 1024 * 1024) throw new Forbidden('file not allowed');
  // loaded/unloaded photos need lat, lng and taken_at. The server compares them with the site geofence and its own clock
  // and sets flags 'outside_geofence' / 'clock_skew' (flag for review, never block the driver) (BR-25).
  await assertTripAssignedTo(actor, trip_id);
  const key = `pod/${trip_id}/${crypto.randomUUID()}`;               // random key, never user-supplied
  return Response.json({ url: await presignPut(key, { mime, size, sha256, expiresIn: 300 }), key });
});
```

### 10.7 Piece-rate payroll computation

The weekly computation is a **system job** (pg-boss, Saturday 06:00 PHT for the Sat–Fri period that just ended); no person runs it,
so nobody computes or approves their own pay. A person can only (a) propose an adjustment (HR, then Owner approves) or (b) ask the
Owner to reopen a period that is not yet `paid`. Everything below runs in one transaction.

```sql
-- Entries are priced at entry time: the rate in force that day, client-specific rate first.
SELECT r.rate
FROM activity_rates r
WHERE r.activity_id = :activity
  AND (r.client_id = :client OR r.client_id IS NULL)
  AND r.effective_from <= :work_date AND (r.effective_to IS NULL OR r.effective_to >= :work_date)
ORDER BY (r.client_id IS NOT NULL) DESC, r.effective_from DESC
LIMIT 1;

-- Compute a period: approved entries only, lock them in the same transaction.
INSERT INTO payroll_lines (period_id, employee_id, source, ref_id, description, qty, rate, amount)
SELECT :period, e.worker_id, 'production', e.id, a.name, e.qty, e.rate_snapshot, e.amount
FROM production_entries e JOIN production_activities a ON a.id = e.activity_id
WHERE e.status = 'approved' AND e.work_date BETWEEN :start AND :end;

UPDATE production_entries SET status = 'locked'
WHERE status = 'approved' AND work_date BETWEEN :start AND :end;
```

Trip pay: one flat line per crew member per completed trip, rate by role and date (BR-17). It is earned on the day the trip
was **completed** (`trips.completed_at`, Manila date), not the day it was planned, so a trip planned on Friday and finished
on Saturday is paid in the following week's run and never twice. The unique index `payroll_line_once` blocks double payment.

```sql
WITH crew AS (
  SELECT t.id AS trip_id, t.trip_no, t.driver_id AS employee_id, 'driver'::text AS crew_role,
         (t.completed_at AT TIME ZONE 'Asia/Manila')::date AS d
    FROM trips t
   WHERE t.completed_at IS NOT NULL AND t.status <> 'cancelled' AND t.driver_id IS NOT NULL
     AND (t.completed_at AT TIME ZONE 'Asia/Manila')::date BETWEEN :start AND :end
  UNION ALL
  SELECT t.id, t.trip_no, h.employee_id, 'helper', (t.completed_at AT TIME ZONE 'Asia/Manila')::date
    FROM trips t JOIN trip_helpers h ON h.trip_id = t.id
   WHERE t.completed_at IS NOT NULL AND t.status <> 'cancelled'
     AND (t.completed_at AT TIME ZONE 'Asia/Manila')::date BETWEEN :start AND :end
)
INSERT INTO payroll_lines (period_id, employee_id, source, ref_id, description, qty, rate, amount)
SELECT :period, c.employee_id, 'trip', c.trip_id, 'Trip ' || c.trip_no, 1, r.amount_per_trip, r.amount_per_trip
  FROM crew c
  JOIN trip_pay_rates r ON r.crew_role = c.crew_role AND r.effective_from <= c.d
                       AND (r.effective_to IS NULL OR r.effective_to >= c.d);

-- Close the computation: freeze the figure that the four sign-offs will be given on.
UPDATE payroll_periods
   SET status = 'computed', computed_at = now(), computed_by_job = 'weekly-payroll',
       total_snapshot = (SELECT COALESCE(SUM(amount), 0) FROM payroll_lines WHERE period_id = :period AND voided_at IS NULL)
 WHERE id = :period AND status = 'open';
```

Reopen (Owner only, reason required, step-up, audited; refused once the period is `paid`): void the system-generated lines
with `void_reason`, set the locked entries back to `approved`, set the period to `open` and add 1 to `round`. Earlier sign-offs
stay on record but only sign-offs of the current round count, and each must show a `total_seen` equal to the new `total_snapshot`.

### 10.8 Returns and approval requests

```ts
// Rent stops at rr.receivedAt (BR-06). 'lost' lines are charged, not moved.
export async function postReturn(tx: Tx, rr: ReturnReceiptRow, lines: ReturnLine[], actor: Actor) {
  if (!lines.length) throw new Error('return receipt has no lines');
  if (rr.returnMode === 'client_delivers' && rr.classifiedAt !== 'rppc_plant') throw new Error('plant delivery is classified at the plant');
  // RPPC pickup: pallets are on our truck until they reach the plant (a later in_transit → plant movement). Client delivery: straight to the plant.
  if (rr.returnMode === 'rppc_pickup' && !rr.tripId) throw new Error('an RPPC pickup return needs its trip');
  const to = rr.returnMode === 'rppc_pickup' ? IN_TRANSIT_LOCATION_ID : PLANT_LOCATION_ID;
  for (const l of lines.filter((x) => x.condition !== 'lost')) {
    await tx.query(
      `INSERT INTO pallet_movements
         (occurred_at, pallet_type_id, condition, qty, from_location_id, to_location_id, ref_type, ref_id, trip_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'return_receipt',$7,$8,$9)`,
      [rr.receivedAt, l.palletTypeId, l.condition, l.qty, rr.siteLocationId, to, rr.id,
       rr.returnMode === 'rppc_pickup' ? rr.tripId : null, actor.id],
    );
  }
  await tx.query(`UPDATE return_receipts SET status='received' WHERE id=$1`, [rr.id]);
  await audit(tx, actor, 'rr.received', 'return_receipt', rr.id, null, { lines });
}

// The pickup truck reaches the plant: unload exactly what that trip is carrying (from v_trip_in_transit) into the plant.
export async function postReturnArrival(tx: Tx, trip: TripRow, arrivedAt: Date, actor: Actor) {
  const { rows } = await tx.query<{ palletTypeId: string; condition: string; qty: number }>(
    `SELECT pallet_type_id AS "palletTypeId", condition, qty FROM v_trip_in_transit WHERE trip_id = $1`, [trip.id]);
  for (const l of rows) {
    await tx.query(
      `INSERT INTO pallet_movements
         (occurred_at, pallet_type_id, condition, qty, from_location_id, to_location_id, ref_type, ref_id, trip_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'trip_arrival',$7,$7,$8)`,
      [arrivedAt, l.palletTypeId, l.condition, l.qty, IN_TRANSIT_LOCATION_ID, PLANT_LOCATION_ID, trip.id, actor.id]);
  }
  await tx.query(`UPDATE trips SET completed_at = COALESCE(completed_at, $2) WHERE id = $1`, [trip.id, arrivedAt]);
}

// Anything that waits for an approver goes through here (voucher, SO, proposal, payroll step, ...).
export async function requestApproval(
  tx: Tx,
  p: { entityType: string; entityId: string; permission: Permission; summary: string; link: string; requestedBy: string },
) {
  const { rows } = await tx.query(
    `INSERT INTO approval_requests (entity_type, entity_id, required_permission, summary, link, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.entityType, p.entityId, p.permission, p.summary, p.link, p.requestedBy],
  );
  const approvers = await tx.query(
    `SELECT DISTINCT ur.user_id
       FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE rp.permission_code = $1 AND ur.user_id <> $2`,
    [p.permission, p.requestedBy],                       // the requester is never notified as an approver
  );
  for (const a of approvers.rows) {
    await notify(tx, a.user_id, {
      kind: 'approval_needed', title: 'Needs your approval', body: p.summary, link: p.link,
      channels: ['in_app', 'push', 'email'],
    });
  }
  return rows[0].id as string;
}

// pg-boss job, every 30 minutes between 06:00 and 22:00 PHT:
//   pending > 2 h and reminder_count < 3  → remind the approvers, reminder_count + 1
//   pending > 4 h                          → FYI to OPS_MGR (cannot approve)
//   07:30 daily                            → digest of everything still pending
declare function notify(tx: Tx, userId: string, n: { kind: string; title: string; body?: string; link?: string; channels: string[] }): Promise<void>;
```

## 11. Non-functional requirements

| Area | Requirement |
|---|---|
| Devices | Android Chrome (mid-range phones) and desktop Chrome/Edge. Touch targets ≥ 44 px; large-type driver screens |
| Connectivity | Driver/helper/guard flows work **offline**; sync on reconnect; photos compressed before upload (target ≤ 500 KB, hard cap 2 MB), with GPS and time stored per photo |
| Performance | Page loads ≤ 2 s on 4G; billing generation for 100 sites ≤ 60 s |
| Availability | 99.5% monthly in business hours (06:00–22:00 PHT); maintenance windows announced |
| Time and money | Store UTC, display `Asia/Manila`; PHP only; VAT 12% computed in exports, rates stored VAT-exclusive |
| Language | English UI; Filipino labels for field screens where helpful |
| Accessibility | Readable contrast, no information by color alone |
| Data | Retention schedule per §8.6; soft-void only for documents; exports always include a document hash/version |

## 12. Integrations and exports (v1: manual by design)

| Export | Format | Consumer | Contents |
|---|---|---|---|
| Billing summary pack | CSV + PDF | Finance → SAP B1 / Crystal Reports | client code, site, period, pallet-days, rate, rental, delivery fees, repair charges, DR list, client approval ref |
| Payroll register | CSV/XLSX | HR/Finance | week, employee no., line detail, totals (piece-rate gross only) |
| Trip budget/voucher register | CSV | Finance | trip no., voucher no., budget, released, actual |
| Pallet inventory snapshot | CSV | Anyone with `inventory.read` | balances by location/condition |

Each export is permission-gated, audited, stamped with who/when/filters, and filename-versioned. A live SAP B1 integration (Service Layer or DI API) is a possible Phase 4 and is out of scope now.

## 13. Reports and dashboards

- **Owner**: pallets deployed (total, by region, by client), pallets at plant vs in circulation, trips this week, billing progress vs cutoff, payroll weekly summary, open client concerns by age.
- **Operations**: today's trips and status, DR without POD, pending vouchers, stock by condition, pending audits, reschedules by reason.
- **Billing/Finance**: summaries by status, awaiting client approval, dispute deadlines, KPI "invoices sent before the 10th", export log.
- **Production**: output per day per activity, per worker, pallets fabricated vs received at yard, flagged entries, payroll per week.
- **Sales**: proposals by status and validity, contracts expiring in 90 days, sales orders by client.

## 14. Data migration and opening balances

1. Import clients, sites, active contracts/proposals (CSV templates provided in the build).
2. **Opening pallet balance per site**: one `ref_type='opening_balance'` movement from the `external` location to each site, dated the cut-over day; reconciled against your latest pallet inventory report and the 640,000 deployed figure before go-live. Unknown condition mix is booked as `A` and corrected by audits.
3. Load the activity/rate table from the Production Tracker (Appendix B) after you confirm the rates.
4. Load employees and enroll devices.
5. **Parallel run**: Phase 1 runs beside Excel for one full billing cycle; the billing summary must match Excel to the peso before Excel is retired.
6. The **Pallet Pooling System** named in the company profile is parked until after the first round of changes. Version 1 starts from opening balances.
7. Pallet type `ECR-1200x1000`: dynamic load **1,500 kg** (confirmed); static load 3,000 kg is taken from the company profile and still to be confirmed.
8. Trip pay: driver ₱1,000, helper ₱600 per trip. Client cutoffs: Del Monte on the 25th *(assumed)*, all others on the 10th until you say otherwise.

## 15. Testing and acceptance

| Layer | What |
|---|---|
| Unit | Rental-day math (delivery day counts, return day does not, same-day in/out), zone fee on partial loads, rate selection, SoD helpers, state machines |
| DB | Negative-stock trigger, immutability triggers, doc-number gap-free under concurrency (100 parallel inserts), audit chain verification |
| Integration | End-to-end: proposal → SO → trip → DR → POD → ledger → billing summary → export |
| Security | Every route has a permission; test matrix proves each role is denied what it should be; IDOR tests (client A cannot read client B; driver cannot read others' trips); upload abuse; session fixation; CSRF; rate limiting; dependency audit in CI |
| Offline | Airplane-mode delivery, double-submit replay, clock-skewed phone |
| UAT scripts | One per role, run by the real staff member, signed off before each phase release |

**Phase 1 acceptance:** (1) a real client's month is billed from the app and matches Excel; (2) 20 consecutive trips complete with POD and no manual paper except the physical voucher; (3) a deliberate attempt to self-approve, dispatch without a voucher, or take negative stock is blocked and audited.

## 16. Delivery plan (indicative)

| Step | Content | Effort (1 dev + AI assist) |
|---|---|---|
| 0 | Foundation, auth, RBAC, audit, masters, files | 3–4 weeks |
| 1a | Proposals/contracts/PDF, sales orders | 3 weeks |
| 1b | Work orders, trips, vouchers, DR, gate pass, POD PWA | 4–5 weeks |
| 1c | Inventory ledger, billing summary, exports, dashboards, parallel run | 3–4 weeks |
| 2 | Production capture, approvals, piece-rate payroll, audit, concerns | 6–8 weeks |
| 3 | Procurement, onsite repair, client portal, channels | 8+ weeks |

Estimates are rough and depend on answers to §18 and on how much of the build is delegated.

## 17. Risks

| Risk | Mitigation |
|---|---|
| Field staff low phone literacy/connectivity | Big-button screens, offline queue, supervisor encoding fallback, short training + UAT per role |
| Parallel Excel and app drift | Single cut-over date per module; Excel read-only after parallel run |
| Wrong opening balances | Reconcile per site; audits correct; adjustments need approval |
| Rule ambiguity (day counting, deemed acceptance) | Make configurable; decide in §18 before building billing |
| Regulatory questions (system-generated DR, e-signature, privacy) | Confirm with your accountant/counsel before relying on them |
| Messaging-channel integrations (Messenger/WhatsApp/Viber) need provider business verification and may not expose personal chats | Phase 3, manual/forward capture first |
| Phone GPS and clocks can be faked or wrong | Photos are taken in the app only (no gallery), accuracy recorded, flags for far-from-site and clock skew, Operations reviews flagged trips, occasional call-back to the client |
| One-developer dependency | Documentation, tests, runbooks, migrations in repo |

## 18. Decisions log and assumptions

### Decided

| Topic | Decision | Where |
|---|---|---|
| Pooling system | Parked until after the first round of changes | §14 |
| DR | One per trip; system DRs accepted via memorandum; Crystal Report copy attachable | BR-22 |
| Rent start | Delivered and DR signed and received at the client site | BR-06 |
| Rent stop | RPPC team receives pallets back: at the client site (pickup) or at the plant (client delivers) | BR-06, §7.4 |
| Damage class | Recorded where the check happens: client site audit before return, or at the RPPC plant | §5 M5, M9 |
| Pallet spec | Dynamic load 1,500 kg | §14 |
| Trip pay | ₱1,000 driver, ₱600 helper, flat per trip, weekly run | BR-17 |
| Pay period | Saturday–Friday; payday Saturday afternoon; cash by HR, witnessed by Security | BR-16, BR-24 |
| Weekly sign-off | Production Officer, HR, Security (quantity and payout) and Finance; then Owner | §8.3 |
| Counts | Paper sheet to Security, who encode; Production Officer approves | §5 M8 |
| Vouchers | Owner approves all; Finance head/cashier releases; no ceiling | BR-23 |
| Photos | 1–2 per stage, small, GPS and timestamp mandatory; flagged, not blocked | BR-20, BR-25 |
| Billing cutoff | Per client, changeable any time with history | BR-07 |
| Approvals | Approvers are notified in-app, by push and by email, with reminders | §5 M13 |
| Terms | BNEP, MRT, Growsari, BAKLAS, PLAINER, CV | Appendix A |

### Assumptions you can change later (no answer needed now)

1. Del Monte's cutoff is the 25th; all other clients use the 10th until you change them. A billing summary runs from the day after the previous cutoff through this cutoff.
2. There is no alternate approver for vouchers: you get reminders instead. Only trip vouchers are in scope; other petty cash can follow later.
3. Photo flags: more than 300 m from the site, or a phone clock off by more than 10 minutes.
4. The client acknowledges the return count when RPPC collects; for a client delivery the plant count is the record.
5. Static load is 3,000 kg (from the company profile).
6. Stack and hosting as in §9 (one Singapore-region host).
7. Client portal comes in Phase 3. The role mapping in §3 is as written.

## 19. Build guide for Claude Code

**Use:** save this file as `docs/SPEC.md` in a new repo, add the `CLAUDE.md` below, then build **one slice at a time**. The SQL in §7 (sections 7.1 to 7.10, run in order, plus the seed in §10.1) was loaded and tested on PostgreSQL 16. The TypeScript in §10 is reference code: it was type-checked (`tsc --strict`) but not run, so write tests first. `packages/core/rbac.ts` is generated: edit the catalog, never the derived lists.

### 19.1 `CLAUDE.md` (put in the repo root)

````md
# RPPC Operations System

Source of truth: docs/SPEC.md. Do not invent business rules. If a rule is missing or unclear, stop and ask.

## Stack
TypeScript, Next.js (App Router), PostgreSQL 16, pg-boss jobs, S3-compatible private storage, PWA for field users.

## Rules
1. Every API route is wrapped in route(permission, handler). No route without a permission. Permissions are checked on the server.
2. Migrations are numbered SQL files in packages/db/migrations. Never edit an applied migration; add a new one.
3. Issued documents (SO, DR, gate pass, billing summary, return receipt) are never edited or deleted: void with a reason.
   pallet_movements and audit_log are append-only; corrections are reversal entries.
4. Money is numeric(14,2). No floating point for money. Store UTC, display Asia/Manila.
5. Every state change writes an audit_log row in the same transaction.
6. Segregation of duties (spec 8.3): approver is never the creator or the payee. The Owner approves every voucher.
7. Write the test first for each business rule. Name tests after the rule id (BR-06 etc.).
8. Never log passwords, PINs, tokens, TOTP secrets or photos.
9. Field screens (driver, helper, guard, worker) are mobile-first, big buttons, and work offline with idempotent sync.
10. Exports (billing, payroll) are permission-gated and audited.
11. Permissions come from one catalog (spec 10.2). PIN sessions can never use a sensitive permission. Quantities on trips live in trip_lines; every in_transit movement carries a trip_id.

## Definition of done for a slice
Migration + API + UI + tests (rules, permissions matrix, IDOR) + audit rows + short note in docs/CHANGELOG.md.
````

### 19.2 Slice order

| Phase | Slices |
|---|---|
| 0 Foundation | S0.1 repo, CI, docker-compose Postgres · S0.2 migrations from §7.1–7.2 and DB tests · S0.3 auth: password + TOTP, PIN + enrolled device, sessions, lockout · S0.4 RBAC seed, `route()` wrapper, a test proving the §8.4 matrix · S0.5 audit log and document numbering · S0.6 masters (clients, sites, zones, trucks, employees) with CSV import · S0.7 file uploads with signed URLs and virus scan · S0.8 approvals inbox, notifications, web push, reminder job (§5 M13) |
| 1 Order-to-delivery | S1.1 proposals + PDF · S1.2 contracts + renewal alerts · S1.3 sales orders · S1.4 work orders, trips, vouchers (Owner approves, Finance releases) · S1.5 DR + gate pass + QR · S1.6 driver/helper PWA with offline proof of delivery · S1.7 ledger postings: dispatch, delivery, return + opening balances · S1.8 billing summary + export · S1.9 dashboards and parallel run |
| 2 Production and payroll | S2.1 activities and rates · S2.2 paper-sheet encoding by Security + Production Officer approval · S2.3 weekly payroll (production + trip pay) · S2.4 four-way sign-off + Owner approval · S2.5 Saturday payout record · S2.6 pallet audit · S2.7 client concerns · S2.8 employee gate pass |
| 3 Procurement and field | Purchasing, materials stock, container shipments, mobile onsite repair, client portal, channel integrations |

### 19.3 First prompts to give Claude Code

1. "Read docs/SPEC.md and CLAUDE.md. Create the monorepo skeleton from section 9 with docker-compose Postgres. Apply the SQL in sections 7.1 and 7.2 as migrations 0001 and 0002. Write DB tests for next_doc_no (100 parallel inserts, no gaps), forbid_mutation and the audit hash chain. No UI yet."
2. "Implement slice S0.3 and S0.4: authentication (password with argon2id, TOTP, device-bound PIN, sessions) and the RBAC seed with the route() wrapper. Add a test that loops over every role and every permission and checks it against the matrix in section 8.4, and a test that a PIN session is rejected for every sensitive permission."
3. "Implement slice S1.7: ledger postings for dispatch, delivery and return, plus the opening balance import. Test BR-06 (rent starts at signed DR, stops at return receipt, end-of-day rule) using fn_location_daily_balance."

### 19.4 Checks that must pass in CI

- Every route declares a permission (static check).
- Permission matrix test (each role denied what it should be denied).
- IDOR tests: client A cannot read client B; a driver cannot read another driver's trip; a worker sees only own earnings.
- SoD tests: self-approval of SO, voucher, production entry and payroll step is rejected.
- Ledger tests: negative stock blocked; movements and audit rows cannot be updated or deleted.
- Billing test: pallet-days and amount match a hand-calculated month.
- Audit chain verification returns no broken row, including when the verifier runs under a different session time zone.
- Generated copies (SQL seed, §8.4 matrix) equal the catalog in §10.2.
- Reissue tests: a voided DR, gate pass, voucher or billing summary can be re-created; a rejected production entry can be re-entered; a voided payroll line can be paid again; a live duplicate is still refused.
- Overlap tests: two active rate terms, two live billing summaries or two payroll periods covering the same dates are refused.
- Billing test for the pre-contract case: days before the contract start are billed at the proposal rate; a day with pallets and no rate term blocks finalisation.
- RLS tests: `app_user` sees all rows; `app_client` sees only its client's rows and none when `app.client_id` is unset.

---

## Appendix A — Glossary

ECR: Efficient Consumer Response pallet · BNEP: Brand New ECR Pallet · MRT: Mobile Repair Team (onsite repair) · Growsari: a client · BAKLAS: dismantling a whole pallet · PLAINER: planing lumber and cutting notches for bottom boards · CV: container van unloading · DR: delivery receipt · POD: proof of delivery · BER: beyond economic repair · Dehire: return of rented pallets before/at term · Principal: the billed client · Zone matrix: fee/cost per delivery zone · SO/WO: sales order / work order.

## Appendix B — Piece rates seen in the August production tracker (verify before seeding)

| Activity (as written) | Rate (₱) |
|---|---|
| BNEP (brand new ECR pallet) fabrication | 17.50 / pc |
| ECR repair Class A&B | 15 / pc |
| BNEP blue paint | 10 / pc |
| BNEP orange paint | 10 / pc |
| BNEP brown paint | 6 / pc |
| ECR repair paint | 5 / pc |
| ECR repair dipping | 2 / pc |
| Good pallet paint / dipping | 5 / 2 per pc |
| Branding (Unilever) | 2 / pc |
| Chamfering bottom board | 3 / pc |
| Shipping/loading (Unilever pallet) | 35 / pallet |
| Onsite repair (GCI, DMPI, Unilever) | 10 / pc |
| Onsite baklas (dismantling whole pallets) | 20 / pc |
| Onsite BER (NAM) | 15 / pc |
| Plainer (planing lumber, notches for bottom boards), daily | 600 / day |
| Unloading container van 4×20 | 3,600 lump sum |

Observed: ~30 workers/day, daily payout ₱10k–₱36k, ~455–540 BNEP pallets on busy days. Rates appear to vary per client and activity, which is why `activity_rates` supports client-specific, effective-dated rates.

## Appendix C — What the source documents told us

- **Proposal (Onestop Warehousing, 29 Oct 2024):** 240-pallet minimum, ₱0.85/pallet/day VAT-exclusive, 1-year minimum, damage matrix A–E/BER/Lost, monthly audit with 5-day notice, 30-day payment, 5-business-day dispute window, agreement to be signed within 15 days of first delivery, validity date, client collects pallets from the depot. All encoded as business rules BR-05 to BR-12 and as proposal fields.
- **Company profile:** 1.7 ha plant (expandable by 1.3 ha), ~10,000 pallets/month, ~600,000 in circulation, goal 1,000,000 deployed; milling in Cagayan de Oro with weekly container shipments; services include onsite and mobile repair, pallet audit, handling seminars, painted pallets, pallet protector.
- **Payroll summary:** weekly totals, headcount, average/highest/lowest, manhours. Reproduced by the report in §7.7.
- **Production tracker:** one sheet per day with many activity blocks and an employee gate-pass sheet (employee gate pass is included as a small HR module in Phase 2).

## Appendix D — Review log (v0.4 → v0.5)

Every finding from the Claude Code review of v0.4, what changed, and where.

| # | Finding | Fix | Where |
|---|---|---|---|
| 1 | Pre-contract deliveries billed at ₱0 | Rates come from `site_rate_terms` (proposal term, then contract term); unpriced days block finalising | §7.3, §7.6, BR-28, BR-10 |
| 2 | No pallet type/condition on trips, DRs, returns | `trip_lines`; DR total is the sum of lines; `return_receipt_lines.pallet_type_id`; postings loop over lines | §7.4, §10.5, §10.8 |
| 3 | Voids/rejections/reopen block reissue | Partial unique indexes on DR, gate pass, voucher; billing summaries use an overlap `EXCLUDE` that ignores void; production entry index ignores rejected; payroll lines carry `voided_at` | §7.4, §7.6, §7.7 |
| 4 | Audit hash depends on session time zone | One `audit_row_hash` used by trigger and verifier, timestamp as fixed UTC text, explicit NULL markers | §7.1 |
| 5 | RLS hides every DR from the app | `app_user` and `app_client` roles with explicit policies; client policies fail closed | §7.10 |
| 6 | No client-pickup path without voucher | `voucher_required` generated column; separate pickup transition table and POD rule | §7.4, §10.4, BR-26 |
| 7 | Overlapping contracts double-count | `EXCLUDE` on `site_rate_terms` | §7.3, BR-28 |
| 8 | Billing export: matrix vs code | Both generated from one catalog; Billing and Finance both export | §10.2, §8.4 |
| 9 | Production entry: HR, drivers, helpers | HR read-only; drivers/helpers have no production permission | §10.2, §8.4 |
| 10 | No `trips.read` | Added (`trips.read`, `dr.read`, `billing.read`, `production.read`, `payroll.read`, `rates.read`, `proposals.read`) | §10.2 |
| 11 | Ops Mgr "A" on trips undefined | `wo.approve` | §10.2 |
| 12 | Returns, audits, signed DR have no permission | `returns.record`, `pallet_audit.write/approve`, `dr.receive` | §10.2 |
| 13 | HR computes then signs off payroll | System job computes; HR proposes adjustments, Owner approves; sign-offs tied to frozen total and round | §7.7, §10.7, §8.3 |
| 14 | Photo size 10 MB vs 2 MB | 2 MB for delivery photos everywhere | §8.5, §10.6, §11 |
| 15 | No holiday calendar for BR-08 | `holidays` + `add_business_days` | §7.1, BR-08 |
| 16 | Owner-raised voucher cannot be approved | `owner_raised` auto-approval, Finance still releases, DB `CHECK` | §7.4, BR-27 |
| 17 | Trip pay dated by planned date | Dated by `completed_at` (Manila date) | §7.4, §10.7, BR-17 |
| 18 | §7.9 after §8; M13 before M12 | Reordered; new §7.10 for roles and RLS | §5, §7 |
| — | Found while fixing: PIN sessions not technically barred from money permissions | `sensitivity` on every permission; enforced in `requirePermission` | §8.1, §10.3 |
| — | Found while fixing: a site could be paired with another client's order | Composite foreign keys `(site_id, client_id)` | §7.2, §7.4, §7.6 |
| — | Found while fixing: in-transit stock shared by all trucks | `pallet_movements.trip_id`, per-trip balance check, `v_trip_in_transit` | §7.5 |
| — | Found while fixing: overlapping rate/payroll periods | `EXCLUDE` constraints on activity rates, trip pay rates, payroll periods | §7.7 |
