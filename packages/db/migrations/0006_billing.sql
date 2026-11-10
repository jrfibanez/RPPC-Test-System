-- 0006_billing: extracted verbatim from docs/SPEC.md §7.6 (line 861). Do not edit; add a new migration.
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
