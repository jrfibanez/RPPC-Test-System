-- 0007_production_payroll: extracted verbatim from docs/SPEC.md §7.7 (line 924). Do not edit; add a new migration.
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
