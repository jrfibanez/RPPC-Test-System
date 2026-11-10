-- 0008_crm_audit: extracted verbatim from docs/SPEC.md §7.8 (line 1047). Do not edit; add a new migration.
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
