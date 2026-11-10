-- 0001_foundation: extracted verbatim from docs/SPEC.md §7.1 (line 255). Do not edit; add a new migration.
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
