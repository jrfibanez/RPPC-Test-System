-- 0013_domain_support: columns the functional text (§5) asks for but §7 does not carry. No new rules.

-- §5 M1: "Accreditation needs a document upload (e.g. credit/KYC form)".
ALTER TABLE clients ADD COLUMN accreditation_file_id uuid REFERENCES files(id);
ALTER TABLE clients ADD CONSTRAINT accredited_needs_document
  CHECK (status <> 'accredited' OR accreditation_file_id IS NOT NULL);

-- §5 M2: a proposal conforme is for a site (the rate term is per site). Which site the proposal is for:
ALTER TABLE proposals ADD COLUMN site_id uuid REFERENCES client_sites(id);
ALTER TABLE proposals ADD COLUMN void_reason text;
ALTER TABLE proposals ADD COLUMN submitted_at timestamptz, ADD COLUMN approved_at timestamptz, ADD COLUMN sent_at timestamptz;
ALTER TABLE contracts ADD COLUMN created_by uuid REFERENCES users(id);

-- §5 M4: rescheduling logs a reason; §10.4 trip timeline needs the receiver evidence of the trip.
ALTER TABLE trips ADD COLUMN cancel_reason text;

-- §5 M5: gate pass verification records the plate the guard confirmed.
ALTER TABLE gate_passes ADD COLUMN plate_confirmed text, ADD COLUMN void_reason text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- §5 M7: billing summary lines keep the DR / return receipt they came from (ref_type/ref_id already exist);
-- the export is versioned and hashed (§11 Data: "exports always include a document hash/version").
CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('billing','payroll','voucher_register','inventory_snapshot')),
  filename text NOT NULL, sha256 text NOT NULL, row_count int NOT NULL, filters jsonb NOT NULL DEFAULT '{}',
  exported_by uuid NOT NULL REFERENCES users(id), exported_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON exports TO app_user;
