-- 0014_audit_chain_concurrency: fixes a defect in the §7.1 trigger found by the test suite.
-- The bigserial id is drawn BEFORE the trigger takes the advisory lock, so two concurrent transactions can take ids
-- 10 and 11 but acquire the lock in the opposite order. The chain then links 11→9 and 10→11, and fn_verify_audit_chain
-- (which walks by id) reports a break although nothing was tampered with. Fix: draw the id inside the lock, so id order
-- equals chain order. Same hash function (audit_row_hash) as before; existing rows are unaffected.
CREATE OR REPLACE FUNCTION trg_audit_chain() RETURNS trigger AS $$
DECLARE v_prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(727001);
  NEW.id := nextval(pg_get_serial_sequence('audit_log', 'id'));
  SELECT hash INTO v_prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(v_prev, '\x00'::bytea);
  NEW.hash := audit_row_hash(NEW.prev_hash, NEW.id, NEW.at, NEW.actor_id, NEW.action,
                             NEW.entity_type, NEW.entity_id, NEW.before, NEW.after);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
