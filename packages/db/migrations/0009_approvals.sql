-- 0009_approvals: extracted verbatim from docs/SPEC.md §7.9 (line 1084). Do not edit; add a new migration.
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
