-- 0002_masters: extracted verbatim from docs/SPEC.md §7.2 (line 446). Do not edit; add a new migration.
CREATE TABLE clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text UNIQUE NOT NULL,
  legal_name     text NOT NULL,
  trade_name     text,
  tin            text,
  address        text,
  status         text NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect','accredited','suspended')),
  accredited_by  uuid REFERENCES users(id),
  accredited_at  timestamptz,
  payment_terms_days int NOT NULL DEFAULT 30,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_cutoff_settings (          -- cutoff can change anytime; history is kept
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  cutoff_day int NOT NULL CHECK (cutoff_day BETWEEN 1 AND 28),
  effective_from date NOT NULL,                 -- applies from the next period start, never to issued summaries
  set_by uuid NOT NULL REFERENCES users(id), reason text,
  UNIQUE (client_id, effective_from)
);
-- Cutoff in force on a date = the row with the latest effective_from <= that date; 10 if there is none.

CREATE TABLE delivery_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL, region text NOT NULL CHECK (region IN ('Luzon','Visayas','Mindanao')),
  km_from_plant numeric(8,1)
);
CREATE TABLE zone_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid NOT NULL REFERENCES delivery_zones(id),
  fee_per_trip numeric(12,2) NOT NULL CHECK (fee_per_trip >= 0),
  est_trip_cost numeric(12,2),                 -- diesel/toll/etc, from cost generator
  effective_from date NOT NULL, effective_to date
);

CREATE TABLE client_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  name text NOT NULL, address text NOT NULL,
  region text CHECK (region IN ('Luzon','Visayas','Mindanao')),
  zone_id uuid REFERENCES delivery_zones(id),
  lat numeric(9,6), lng numeric(9,6), geofence_m int NOT NULL DEFAULT 300,   -- flags photos taken far from the site
  contact_name text, contact_mobile text,
  UNIQUE (client_id, name),
  UNIQUE (id, client_id)                       -- target of composite foreign keys (SO, DR, billing)
);

CREATE TABLE pallet_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,                   -- 'ECR-1200x1000'
  length_mm int, width_mm int, height_mm int,
  dynamic_load_kg int, static_load_kg int
);
CREATE TABLE trucks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_no text UNIQUE NOT NULL, capacity_pallets int NOT NULL DEFAULT 240,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired'))
);
