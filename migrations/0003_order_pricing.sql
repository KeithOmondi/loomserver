-- 0003_order_pricing.sql
-- Split an order's discount by who funds it so commission and escrow are exact.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS vendor_discount   numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS platform_discount numeric(12,2) NOT NULL DEFAULT 0;

-- A refund reverses the platform-funded promo in proportion, so track how much has been reversed.
ALTER TABLE escrow_holds
  ADD COLUMN IF NOT EXISTS promo_amount    numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_promo  numeric(12,2) NOT NULL DEFAULT 0;
