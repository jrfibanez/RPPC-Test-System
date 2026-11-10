-- 0012_app_support: infrastructure the spec references but does not spell out as DDL.
-- No new business rules here; each object cites the spec section that needs it.

-- §10.6: idempotent offline sync. Replaying a client_op_id returns the stored result, with no second effect.
CREATE TABLE processed_ops (
  client_op_id uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  result       jsonb,
  created_at   timestamptz DEFAULT now()
);

-- §5 M12 / §10.4: settings (pod.min_loaded_photos, production.allow_self_entry, memorandum file, ...).
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
  ('pod.min_loaded_photos', '1'), ('pod.min_unloaded_photos', '1'), ('pod.max_photos_per_stage', '2'),
  ('pod.geofence_default_m', '300'), ('pod.clock_skew_minutes', '10'),
  ('production.allow_self_entry', 'false'),
  ('so.min_qty', '240'),
  ('billing.default_cutoff_day', '10'),
  ('dr.system_dr_memorandum_file_id', 'null');

-- §8.1: step-up (password/TOTP re-entry, 10 min) and PIN re-entry (5 min) are tracked per session;
-- CSRF token per session (§8.5). Only a hash of the CSRF token is stored.
ALTER TABLE sessions
  ADD COLUMN auth_method        text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password','pin')),
  ADD COLUMN last_step_up_at    timestamptz,
  ADD COLUMN last_pin_reentry_at timestamptz,
  ADD COLUMN csrf_hash          bytea;
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- §8.1: MFA recovery codes, hashed.
CREATE TABLE mfa_recovery_codes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz
);

-- §8.1 brute force: per-IP failure counter (per-account counter is users.failed_logins).
CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY, ip inet, username citext, ok boolean NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip, at);

-- §7.5 / §6: the fixed ledger locations. Every client site gets its own location automatically.
INSERT INTO inventory_locations (type, name) VALUES
  ('plant','Plant — Mamplasan, Biñan'), ('in_transit','In transit'), ('repair_area','Repair area'),
  ('external','External (production in / lost / scrapped / opening balance)');

CREATE OR REPLACE FUNCTION trg_site_location() RETURNS trigger AS $$
BEGIN
  INSERT INTO inventory_locations (type, site_id, name) VALUES ('client_site', NEW.id, 'site:' || NEW.id::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER client_site_location AFTER INSERT ON client_sites FOR EACH ROW EXECUTE FUNCTION trg_site_location();

-- §14 item 7: the ECR pallet (dynamic 1,500 kg confirmed; static 3,000 kg assumed, §18 item 5).
INSERT INTO pallet_types (code, length_mm, width_mm, dynamic_load_kg, static_load_kg)
VALUES ('ECR-1200x1000', 1200, 1000, 1500, 3000);

-- §7 conventions: every table with updated_at keeps it current.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
            JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
           WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND tb.table_type = 'BASE TABLE' LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_updated_at', t);
  END LOOP;
END $$;

-- §8.2: the app connects as app_user with least privilege: no DDL, no TRUNCATE, no DELETE on business data.
GRANT USAGE ON SCHEMA public TO app_user, app_client;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;
-- Append-only tables: no UPDATE even at the privilege level (the triggers also refuse it).
REVOKE UPDATE ON audit_log, pallet_movements FROM app_user;
-- The few rows that are genuinely deletable (not business documents).
GRANT DELETE ON trip_helpers, push_subscriptions, user_roles, mfa_recovery_codes TO app_user;
