-- 0005_inventory_ledger: extracted verbatim from docs/SPEC.md §7.5 (line 759). Do not edit; add a new migration.
CREATE TABLE inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('plant','client_site','in_transit','repair_area','external')),
  site_id uuid REFERENCES client_sites(id),
  name text NOT NULL UNIQUE,
  CHECK ((type = 'client_site') = (site_id IS NOT NULL))
);

CREATE TABLE pallet_movements (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  pallet_type_id uuid NOT NULL REFERENCES pallet_types(id),
  condition text NOT NULL CHECK (condition IN ('new','A','B','C','D','E','BER')),
  qty int NOT NULL CHECK (qty > 0),
  from_location_id uuid NOT NULL REFERENCES inventory_locations(id),
  to_location_id   uuid NOT NULL REFERENCES inventory_locations(id),
  ref_type text NOT NULL, ref_id uuid,           -- 'delivery_receipt', 'audit', 'production', 'reversal', ...
  trip_id uuid REFERENCES trips(id),             -- REQUIRED on every movement into/out of 'in_transit' (so each truck is tracked on its own)
  reversal_of bigint REFERENCES pallet_movements(id),
  note text, created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_location_id <> to_location_id)
);
CREATE INDEX ON pallet_movements (to_location_id, occurred_at);
CREATE INDEX ON pallet_movements (from_location_id, occurred_at);
CREATE TRIGGER pallet_movements_immutable BEFORE UPDATE OR DELETE ON pallet_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Block negative stock at any non-'external' source location
CREATE OR REPLACE FUNCTION trg_pallet_movement_guard() RETURNS trigger AS $$
DECLARE v_type text; v_to_type text; v_balance bigint;
BEGIN
  SELECT type INTO v_type FROM inventory_locations WHERE id = NEW.from_location_id;
  SELECT type INTO v_to_type FROM inventory_locations WHERE id = NEW.to_location_id;
  IF (v_type = 'in_transit' OR v_to_type = 'in_transit') AND NEW.trip_id IS NULL THEN
    RAISE EXCEPTION 'Movements to/from in_transit must carry a trip_id';
  END IF;
  IF v_type <> 'external' THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.from_location_id::text));
    SELECT COALESCE(SUM(CASE WHEN to_location_id = NEW.from_location_id THEN qty ELSE -qty END), 0)
      INTO v_balance
      FROM pallet_movements
     WHERE (to_location_id = NEW.from_location_id OR from_location_id = NEW.from_location_id)
       AND pallet_type_id = NEW.pallet_type_id AND condition = NEW.condition
       AND (v_type <> 'in_transit' OR trip_id = NEW.trip_id);   -- a truck can only unload what that truck loaded
    IF v_balance < NEW.qty THEN
      RAISE EXCEPTION 'Insufficient stock at location % (have %, need %)', NEW.from_location_id, v_balance, NEW.qty;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pallet_movement_guard BEFORE INSERT ON pallet_movements
  FOR EACH ROW EXECUTE FUNCTION trg_pallet_movement_guard();

CREATE VIEW v_pallet_balance AS
SELECT loc_id AS location_id, pallet_type_id, condition, SUM(delta)::bigint AS qty
FROM (
  SELECT to_location_id AS loc_id, pallet_type_id, condition,  qty AS delta FROM pallet_movements
  UNION ALL
  SELECT from_location_id,          pallet_type_id, condition, -qty        FROM pallet_movements
) m GROUP BY loc_id, pallet_type_id, condition;

-- What each trip is carrying right now (should be empty once every trip is delivered or returned).
CREATE VIEW v_trip_in_transit AS
SELECT m.trip_id, m.pallet_type_id, m.condition,
       SUM(CASE WHEN l.type = 'in_transit' AND m.to_location_id = l.id THEN m.qty ELSE -m.qty END)::bigint AS qty
FROM pallet_movements m
JOIN inventory_locations l ON l.type = 'in_transit' AND (l.id = m.to_location_id OR l.id = m.from_location_id)
WHERE m.trip_id IS NOT NULL
GROUP BY m.trip_id, m.pallet_type_id, m.condition
HAVING SUM(CASE WHEN l.type = 'in_transit' AND m.to_location_id = l.id THEN m.qty ELSE -m.qty END) <> 0;

-- End-of-day on-site balance per day (Asia/Manila). Basis of rental billing (BR-06).
CREATE OR REPLACE FUNCTION fn_location_daily_balance(p_loc uuid, p_type uuid, p_from date, p_to date)
RETURNS TABLE(day date, qty_on_hand bigint) LANGUAGE sql STABLE AS $$
  WITH opening AS (
    SELECT COALESCE(SUM(CASE WHEN to_location_id = p_loc THEN qty ELSE -qty END), 0) AS q
      FROM pallet_movements
     WHERE pallet_type_id = p_type
       AND (occurred_at AT TIME ZONE 'Asia/Manila')::date < p_from
       AND (to_location_id = p_loc OR from_location_id = p_loc)
  ), deltas AS (
    SELECT (occurred_at AT TIME ZONE 'Asia/Manila')::date AS d,
           SUM(CASE WHEN to_location_id = p_loc THEN qty ELSE -qty END) AS delta
      FROM pallet_movements
     WHERE pallet_type_id = p_type
       AND (occurred_at AT TIME ZONE 'Asia/Manila')::date BETWEEN p_from AND p_to
       AND (to_location_id = p_loc OR from_location_id = p_loc)
     GROUP BY 1
  ), days AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS d
  )
  SELECT days.d,
         ((SELECT q FROM opening) + SUM(COALESCE(deltas.delta, 0)) OVER (ORDER BY days.d))::bigint
    FROM days LEFT JOIN deltas ON deltas.d = days.d
   ORDER BY days.d;
$$;
