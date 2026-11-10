-- 0015_hosted_hardening: what a hosted Postgres (Supabase) needs, and harmless on a plain Postgres 16.
-- No new business rules.

-- app_user: find pgcrypto where Supabase installs it, and always run in UTC (also through a transaction pooler,
-- where a per-connection SET would not stick).
ALTER ROLE app_user SET search_path = public, extensions;
ALTER ROLE app_user SET timezone = 'UTC';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA extensions TO app_user';
  END IF;
END $$;

-- Supabase exposes the public schema through its Data API to the roles anon (public API key) and authenticated,
-- and by default grants them every new table. This app never uses that API: all access goes through the server
-- with permission checks (§8.2). Remove those grants now and for future tables, or password hashes, payroll and
-- client data would be readable with the public key.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- §8.5 files: a storage driver that keeps the bytes in the database, for hosts without a writable disk (Vercel).
-- Private by construction: only app_user can read it, and the app serves files only through signed URLs.
CREATE TABLE file_blobs (
  storage_key text PRIMARY KEY REFERENCES files(storage_key),
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON file_blobs TO app_user;

-- Defense in depth (§8.2): row-level security on every table. app_user keeps full access through an explicit
-- policy; any other role (anon, authenticated, app_client except where §7.10 grants it) sees nothing.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'app_full_access') THEN
      EXECUTE format('CREATE POLICY app_full_access ON %I FOR ALL TO app_user USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;
