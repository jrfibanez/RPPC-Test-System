-- 0010_db_roles_rls: extracted verbatim from docs/SPEC.md §7.10 (line 1121). Do not edit; add a new migration.
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
