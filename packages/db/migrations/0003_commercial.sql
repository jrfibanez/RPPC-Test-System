-- 0003_commercial: extracted verbatim from docs/SPEC.md §7.3 (line 511). Do not edit; add a new migration.
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
