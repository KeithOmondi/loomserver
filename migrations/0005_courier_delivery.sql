-- 0005_courier_delivery.sql
-- 1) Delivery zones can be matched by neighbourhood ("area") before county, so Westlands and
--    Rongai can cost different amounts.
-- 2) Loom hires the couriers, so the delivery fee belongs to the platform, not the vendor.
--    It is held in escrow with the order and tracked separately from vendor earnings.
--
-- ⚠ The Nairobi area fees below are STARTER ESTIMATES, not real courier rates.
--   Replace them in Back office → Delivery once you know what your couriers charge.

ALTER TABLE shipping_zones ADD COLUMN IF NOT EXISTS areas text[] NOT NULL DEFAULT '{}';

ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_delivery_fee numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE escrow_holds
  ADD COLUMN IF NOT EXISTS delivery_amount    numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_delivery  numeric(12,2) NOT NULL DEFAULT 0;

INSERT INTO platform_settings (key, value, description) VALUES
  ('delivery.handled_by', '"platform"',
   'platform = Loom hires couriers and keeps the delivery fee; vendor = vendors deliver and keep the fee')
ON CONFLICT (key) DO NOTHING;

-- Area zones carry no counties on purpose: they only match through their areas. Anything in
-- Nairobi that is not listed falls back to the county-level "Nairobi metro" zone.
INSERT INTO shipping_zones (name, counties, areas, base_fee, per_kg_fee, free_over, est_days_min, est_days_max)
SELECT v.* FROM (VALUES
  ('Nairobi · Zone A (Central)',   ARRAY[]::text[], ARRAY['CBD','Westlands','Kilimani','Upper Hill','Hurlingham'], 150::numeric, 40::numeric, 5000::numeric, 1, 1),
  ('Nairobi · Zone B (Inner)',     ARRAY[]::text[], ARRAY['Kileleshwa','Lavington','Parklands','South B','South C','Ngara','Eastleigh'], 250::numeric, 50::numeric, 5000::numeric, 1, 2),
  ('Nairobi · Zone C (Outer)',     ARRAY[]::text[], ARRAY['Karen','Lang''ata','Kasarani','Roysambu','Embakasi','Kahawa'], 350::numeric, 60::numeric, 7000::numeric, 1, 2),
  ('Nairobi · Zone D (Outskirts)', ARRAY[]::text[], ARRAY['Rongai','Kitengela','Syokimau','Ruiru','Ngong','Kikuyu'], 500::numeric, 80::numeric, NULL::numeric, 2, 3)
) AS v(name, counties, areas, base_fee, per_kg_fee, free_over, est_days_min, est_days_max)
WHERE NOT EXISTS (SELECT 1 FROM shipping_zones z WHERE z.name = v.name);
