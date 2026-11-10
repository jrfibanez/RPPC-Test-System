-- 0004_orders_trips: extracted verbatim from docs/SPEC.md §7.4 (line 589). Do not edit; add a new migration.
CREATE TABLE sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_no text UNIQUE NOT NULL DEFAULT next_doc_no('SO','SO'),
  order_type text NOT NULL CHECK (order_type IN ('deployment','dehire','pallet_audit','onsite_deployment')),
  client_id uuid NOT NULL REFERENCES clients(id),
  site_id uuid NOT NULL,
  proposal_id uuid REFERENCES proposals(id), contract_id uuid REFERENCES contracts(id),
  qty int NOT NULL CHECK (qty > 0),
  min_qty_override_reason text,
  requested_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','submitted','approved','rejected','scheduled','in_progress','fulfilled','cancelled','void')),
  created_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (proposal_id IS NOT NULL OR contract_id IS NOT NULL OR order_type = 'pallet_audit'),
  FOREIGN KEY (site_id, client_id) REFERENCES client_sites (id, client_id),   -- a site can never belong to another client's order
  UNIQUE (id, client_id, site_id)                                              -- target for the DR composite key
);

CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_no text UNIQUE NOT NULL DEFAULT next_doc_no('WO','WO'),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id),
  qty int NOT NULL CHECK (qty > 0), planned_date date NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','cancelled')),
  reschedule_log jsonb NOT NULL DEFAULT '[]',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_no text UNIQUE NOT NULL DEFAULT next_doc_no('TRIP','TT'),        -- the trip ticket number
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  -- delivery = RPPC truck to client; return = RPPC truck collects from client; pickup = client's own truck loads at the
  -- plant (no RPPC fuel/toll budget, so no voucher, BR-26); internal = plant to plant.
  trip_type text NOT NULL DEFAULT 'delivery' CHECK (trip_type IN ('delivery','pickup','return','internal')),
  voucher_required boolean GENERATED ALWAYS AS (trip_type <> 'pickup') STORED,
  truck_id uuid REFERENCES trucks(id), driver_id uuid REFERENCES employees(id),
  planned_date date NOT NULL,
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('free','charged')),
  zone_id uuid REFERENCES delivery_zones(id),
  delivery_fee numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned'
         CHECK (status IN ('planned','budget_approved','budget_released','loading','dispatched',
                           'at_site','delivered','returned','closed','cancelled')),
  completed_at timestamptz,                      -- set when the trip is delivered/closed; trip pay is earned on this date
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- A trip can carry several pallet types/conditions; quantities live here, never as one number on the trip.
CREATE TABLE trip_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  pallet_type_id uuid NOT NULL REFERENCES pallet_types(id),
  condition text NOT NULL CHECK (condition IN ('new','A','B','C','D','E','BER')),
  qty_planned int NOT NULL CHECK (qty_planned > 0),
  qty_loaded int CHECK (qty_loaded >= 0), qty_delivered int CHECK (qty_delivered >= 0),
  UNIQUE (trip_id, pallet_type_id, condition)
);
CREATE VIEW v_trip_qty AS
  SELECT trip_id, sum(qty_planned) AS planned, sum(qty_loaded) AS loaded, sum(qty_delivered) AS delivered
  FROM trip_lines GROUP BY trip_id;
CREATE TABLE trip_helpers (
  trip_id uuid REFERENCES trips(id) ON DELETE CASCADE, employee_id uuid REFERENCES employees(id),
  PRIMARY KEY (trip_id, employee_id)
);
CREATE TABLE trip_events (                      -- time in / time out and the rest of the timeline
  id bigserial PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id),
  event text NOT NULL CHECK (event IN ('loading_start','loading_end','departed_plant','arrived_site',
        'unloading_start','unloading_end','departed_site','returned_plant')),
  at timestamptz NOT NULL, device_at timestamptz, recorded_by uuid REFERENCES users(id),
  lat numeric(9,6), lng numeric(9,6),          -- GPS stamped only at the moment of a check-in (no continuous tracking)
  UNIQUE (trip_id, event)
);

CREATE TABLE vouchers (                         -- pre-numbered petty cash voucher attached to a trip
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_no text UNIQUE NOT NULL,              -- keyed from the physical pad
  trip_id uuid NOT NULL REFERENCES trips(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','released','liquidated','rejected','void')),
  budget_amount numeric(12,2) NOT NULL CHECK (budget_amount >= 0),
  requested_by uuid NOT NULL REFERENCES users(id),
  owner_raised boolean NOT NULL DEFAULT false,  -- Owner requested it himself: auto-approved, flagged, Finance release is still independent
  approved_by uuid REFERENCES users(id), approved_at timestamptz,   -- always the Owner (BR-23)
  released_by uuid REFERENCES users(id), released_at timestamptz,
  actual_amount numeric(12,2), liquidated_at timestamptz,
  void_reason text,
  CHECK (approved_by IS NULL OR approved_by <> requested_by OR owner_raised),
  CHECK (NOT owner_raised OR approved_by = requested_by),
  CHECK (released_by IS NULL OR (released_by <> requested_by AND released_by IS DISTINCT FROM approved_by))
);
-- One live voucher per trip; a voided/rejected one can be re-issued.
CREATE UNIQUE INDEX voucher_one_live_per_trip ON vouchers (trip_id) WHERE status NOT IN ('void','rejected');

CREATE TABLE delivery_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dr_no text UNIQUE NOT NULL DEFAULT next_doc_no('DR','DR'),
  trip_id uuid NOT NULL REFERENCES trips(id),
  sales_order_id uuid NOT NULL, client_id uuid NOT NULL, site_id uuid NOT NULL,
  qty int NOT NULL CHECK (qty > 0),               -- total of the trip lines; the PDF lists each type/condition line
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','delivered','received','disputed','void')),
  receiver_name text, receiver_signature_file_id uuid REFERENCES files(id),
  delivered_at timestamptz,                       -- unloading finished
  received_at timestamptz,                        -- signed and received at client site = billing start (BR-06)
  external_dr_no text, external_dr_file_id uuid REFERENCES files(id),   -- optional Crystal Report-printed copy (BR-22)
  void_reason text,
  pdf_file_id uuid REFERENCES files(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sales_order_id, client_id, site_id) REFERENCES sales_orders (id, client_id, site_id)
);
-- One live DR per trip (BR-04). Voiding frees the trip so a corrected DR can be issued; the void DR keeps its number.
CREATE UNIQUE INDEX dr_one_live_per_trip ON delivery_receipts (trip_id) WHERE status <> 'void';
CREATE TABLE gate_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gp_no text UNIQUE NOT NULL DEFAULT next_doc_no('GP','GP'),
  trip_id uuid NOT NULL REFERENCES trips(id),
  qty int NOT NULL, verified_by uuid REFERENCES users(id), time_out timestamptz, status text NOT NULL DEFAULT 'issued'
       CHECK (status IN ('issued','verified','void'))
);
CREATE UNIQUE INDEX gp_one_live_per_trip ON gate_passes (trip_id) WHERE status <> 'void';
CREATE TABLE pod_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  stage text NOT NULL CHECK (stage IN ('loaded','unloaded','damage','other')),
  file_id uuid NOT NULL REFERENCES files(id),
  taken_at_device timestamptz, uploaded_at timestamptz NOT NULL DEFAULT now(),   -- uploaded_at = server time
  lat numeric(9,6), lng numeric(9,6), gps_accuracy_m numeric(8,1),
  captured_in_app boolean NOT NULL DEFAULT true,       -- camera in the PWA, no gallery picks
  flags text[] NOT NULL DEFAULT '{}',                  -- 'outside_geofence','clock_skew','low_gps_accuracy'
  uploaded_by uuid NOT NULL REFERENCES users(id),
  CHECK (stage NOT IN ('loaded','unloaded')
         OR (lat IS NOT NULL AND lng IS NOT NULL AND taken_at_device IS NOT NULL AND captured_in_app))
);
CREATE INDEX ON pod_photos (trip_id, stage);

-- Returns / dehire (BR-06). Rent stops at received_at.
CREATE TABLE return_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rr_no text UNIQUE NOT NULL DEFAULT next_doc_no('RR','RR'),
  client_id uuid NOT NULL REFERENCES clients(id), site_id uuid NOT NULL,
  return_mode text NOT NULL CHECK (return_mode IN ('rppc_pickup','client_delivers')),
  classified_at text NOT NULL CHECK (classified_at IN ('client_site','rppc_plant')),
  audit_id uuid,                                  -- optional link to a pallet audit done before the return
  trip_id uuid REFERENCES trips(id),              -- RPPC pickup trip, when RPPC collects
  received_at timestamptz NOT NULL,               -- rent stops here
  received_by uuid NOT NULL REFERENCES users(id),
  client_rep_name text, client_ack_file_id uuid REFERENCES files(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','received','void')),
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, client_id) REFERENCES client_sites (id, client_id)
);
CREATE TABLE return_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_receipt_id uuid NOT NULL REFERENCES return_receipts(id) ON DELETE CASCADE,
  pallet_type_id uuid NOT NULL REFERENCES pallet_types(id),
  condition text NOT NULL CHECK (condition IN ('A','B','C','D','E','BER','lost')),   -- 'lost' = not returned, charged
  qty int NOT NULL CHECK (qty > 0),
  UNIQUE (return_receipt_id, pallet_type_id, condition)
);
