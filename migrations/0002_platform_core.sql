-- 0002_platform_core.sql
-- Additive schema for: staff roles, settings, variants, shipping, promotions, ledger/escrow,
-- payouts, refunds/returns/disputes, messaging, notifications, jobs, audit, CMS pages.
-- Nothing here drops or rewrites existing data.

-- ============================================================
-- Roles & 2FA
-- ============================================================
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role = ANY (ARRAY['customer','seller','moderator','admin','super_admin','support','finance']::text[])
);
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret text,
  ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS totp_backup_codes jsonb;

-- ============================================================
-- Platform settings (admin-editable)
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value, description) VALUES
  ('commission.default_rate',       '10',       'Default platform commission, percent of item value'),
  ('payout.default_schedule',       '"weekly"', 'weekly | monthly'),
  ('payout.minimum_amount',         '500',      'Minimum KES a vendor must have available to be paid out'),
  ('returns.window_days',           '7',        'Days after delivery a customer may request a return'),
  ('escrow.auto_confirm_days',      '7',        'Days after delivery before escrow auto-releases (if no dispute)'),
  ('disputes.response_hours',       '72',       'Hours a party has to respond before auto-escalation'),
  ('orders.unpaid_expiry_minutes',  '30',       'Unpaid orders are cancelled and stock restored after this'),
  ('shipping.default_fee',          '300',      'Fallback delivery fee when no zone matches'),
  ('shipping.free_over',            'null',     'Free delivery when an order subtotal reaches this (null = off)')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE categories ADD COLUMN IF NOT EXISTS commission_rate numeric(5,2);

-- ============================================================
-- Variants
-- ============================================================
CREATE TABLE IF NOT EXISTS product_variants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku              text,
  name             text NOT NULL,
  options          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"Color":"Red","Size":"M"}
  price            numeric(12,2) NOT NULL CHECK (price >= 0),
  compare_at_price numeric(12,2),
  stock_quantity   integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  is_active        boolean NOT NULL DEFAULT true,
  image_url        text,
  position         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);
-- Older code could add the same product twice as separate lines (NULL variant_ids never conflicted).
-- Merge those into one line (summing quantities) so the unique index below can be created.
UPDATE cart_items k SET quantity = s.q
FROM (
  SELECT cart_id, product_id, variant_id, SUM(quantity)::int AS q, (array_agg(id ORDER BY created_at, id))[1] AS keep_id
  FROM cart_items GROUP BY cart_id, product_id, variant_id HAVING COUNT(*) > 1
) s
WHERE k.id = s.keep_id;

DELETE FROM cart_items a USING cart_items b
WHERE a.cart_id = b.cart_id AND a.product_id = b.product_id
  AND a.variant_id IS NOT DISTINCT FROM b.variant_id
  AND (b.created_at, b.id) < (a.created_at, a.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cart_items_line
  ON cart_items (cart_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ============================================================
-- Shipping
-- ============================================================
CREATE TABLE IF NOT EXISTS shipping_zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  counties    text[] NOT NULL DEFAULT '{}',
  base_fee    numeric(10,2) NOT NULL DEFAULT 0,
  per_kg_fee  numeric(10,2) NOT NULL DEFAULT 0,
  free_over   numeric(12,2),
  est_days_min integer NOT NULL DEFAULT 2,
  est_days_max integer NOT NULL DEFAULT 5,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pickup_stations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  county     text NOT NULL,
  address    text NOT NULL,
  phone      text,
  fee        numeric(10,2) NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Orders: fulfilment, escrow and promotion fields
-- ============================================================
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tracking_number       text,
  ADD COLUMN IF NOT EXISTS carrier               text,
  ADD COLUMN IF NOT EXISTS delivery_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_confirm_at       timestamptz,
  ADD COLUMN IF NOT EXISTS escrow_status         text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS commission_total      numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupon_code           text,
  ADD COLUMN IF NOT EXISTS pickup_station_id     uuid REFERENCES pickup_stations(id),
  ADD COLUMN IF NOT EXISTS stock_restored        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expires_at            timestamptz;
CREATE INDEX IF NOT EXISTS idx_orders_expiry ON orders(expires_at) WHERE payment_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_orders_autoconfirm ON orders(auto_confirm_at) WHERE escrow_status = 'held';

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_name text;

-- ============================================================
-- Promotions
-- ============================================================
CREATE TABLE IF NOT EXISTS coupons (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  description    text,
  type           text NOT NULL CHECK (type IN ('percent','fixed')),
  value          numeric(12,2) NOT NULL CHECK (value > 0),
  min_subtotal   numeric(12,2) NOT NULL DEFAULT 0,
  max_discount   numeric(12,2),
  scope          text NOT NULL DEFAULT 'platform' CHECK (scope IN ('platform','store')),
  store_id       uuid REFERENCES stores(id) ON DELETE CASCADE,
  starts_at      timestamptz,
  ends_at        timestamptz,
  usage_limit    integer,
  per_user_limit integer NOT NULL DEFAULT 1,
  used_count     integer NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_coupon_store_scope CHECK ((scope = 'store') = (store_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_coupons_code ON coupons (upper(code));

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id  uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  order_id   uuid NOT NULL REFERENCES orders(id),
  amount     numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coupon_id, order_id)
);

CREATE TABLE IF NOT EXISTS flash_sales (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL CHECK (ends_at > starts_at),
  is_active  boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flash_sale_items (
  flash_sale_id  uuid NOT NULL REFERENCES flash_sales(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sale_price     numeric(12,2) NOT NULL CHECK (sale_price >= 0),
  quantity_limit integer,
  sold           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (flash_sale_id, product_id)
);

CREATE TABLE IF NOT EXISTS banners (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  subtitle   text,
  image_url  text,
  link_url   text,
  placement  text NOT NULL DEFAULT 'home_hero',
  sort_order integer NOT NULL DEFAULT 0,
  starts_at  timestamptz,
  ends_at    timestamptz,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Ledger (double-entry). Balances are ALWAYS derived from entries.
-- ============================================================
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('asset','liability','revenue','expense')),
  owner_type text NOT NULL CHECK (owner_type IN ('platform','store','customer')),
  owner_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL,
  reference_type  text,
  reference_id    uuid,
  idempotency_key text NOT NULL UNIQUE,
  description     text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_ref ON ledger_transactions(reference_type, reference_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id     uuid NOT NULL REFERENCES ledger_accounts(id),
  direction      text NOT NULL CHECK (direction IN ('debit','credit')),
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx ON ledger_entries(transaction_id);

-- Every transaction must balance (debits = credits), checked at COMMIT.
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger AS $$
DECLARE diff numeric;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END), 0)
    INTO diff FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is unbalanced by %', NEW.transaction_id, diff;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- The ledger is append-only: corrections are new (reversing) transactions.
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The ledger is append-only (% on %)', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
DROP TRIGGER IF EXISTS trg_ledger_tx_immutable ON ledger_transactions;
CREATE TRIGGER trg_ledger_tx_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

-- Derived balance per account (natural sign: assets/expenses = debit-credit; others = credit-debit).
CREATE OR REPLACE VIEW ledger_balances AS
SELECT a.id AS account_id, a.code, a.name, a.kind, a.owner_type, a.owner_id,
       COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount ELSE 0 END), 0) AS debits,
       COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE 0 END), 0) AS credits,
       COALESCE(SUM(
         CASE WHEN a.kind IN ('asset','expense')
              THEN CASE e.direction WHEN 'debit' THEN e.amount ELSE -e.amount END
              ELSE CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END
         END), 0) AS balance
FROM ledger_accounts a
LEFT JOIN ledger_entries e ON e.account_id = a.id
GROUP BY a.id;

-- ============================================================
-- Escrow state per order (money itself lives in the ledger)
-- ============================================================
CREATE TABLE IF NOT EXISTS escrow_holds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL UNIQUE REFERENCES orders(id),
  store_id           uuid NOT NULL REFERENCES stores(id),
  seller_id          uuid NOT NULL REFERENCES sellers(id),
  vendor_amount      numeric(12,2) NOT NULL,           -- net owed to vendor (items - commission + shipping)
  commission_amount  numeric(12,2) NOT NULL,
  status             text NOT NULL DEFAULT 'held'
                     CHECK (status IN ('held','released','refunded','partially_refunded')),
  refunded_vendor    numeric(12,2) NOT NULL DEFAULT 0,
  refunded_commission numeric(12,2) NOT NULL DEFAULT 0,
  release_after      timestamptz,
  dispute_locked     boolean NOT NULL DEFAULT false,
  released_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escrow_release ON escrow_holds(release_after) WHERE status IN ('held','partially_refunded');

-- ============================================================
-- Payouts
-- ============================================================
CREATE TABLE IF NOT EXISTS payout_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text NOT NULL,
  schedule     text NOT NULL DEFAULT 'weekly',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','processing','completed','cancelled')),
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users(id),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid REFERENCES payout_batches(id) ON DELETE SET NULL,
  store_id       uuid NOT NULL REFERENCES stores(id),
  seller_id      uuid NOT NULL REFERENCES sellers(id),
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  method         text NOT NULL CHECK (method IN ('mpesa','bank')),
  destination    jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paid','failed','cancelled')),
  attempts       integer NOT NULL DEFAULT 0,
  failure_reason text,
  reference      text,
  paid_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payouts_store ON payouts(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS balance_holds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES stores(id),
  reason      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  released_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_balance_holds_active ON balance_holds(store_id) WHERE active;

-- ============================================================
-- Returns, refunds, disputes
-- ============================================================
ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS order_id      uuid REFERENCES orders(id),
  ADD COLUMN IF NOT EXISTS store_id      uuid REFERENCES stores(id),
  ADD COLUMN IF NOT EXISTS quantity      integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS description   text,
  ADD COLUMN IF NOT EXISTS photos        jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS preferred_resolution text NOT NULL DEFAULT 'refund',
  ADD COLUMN IF NOT EXISTS vendor_response text,
  ADD COLUMN IF NOT EXISTS decided_at    timestamptz,
  ADD COLUMN IF NOT EXISTS return_tracking text,
  ADD COLUMN IF NOT EXISTS received_at   timestamptz;
CREATE INDEX IF NOT EXISTS idx_returns_store ON returns(store_id);
CREATE INDEX IF NOT EXISTS idx_returns_order ON returns(order_id);

CREATE TABLE IF NOT EXISTS refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id),
  store_id     uuid NOT NULL REFERENCES stores(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  return_id    uuid REFERENCES returns(id),
  dispute_id   uuid,
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  method       text NOT NULL DEFAULT 'wallet' CHECK (method IN ('original','wallet')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','processed','rejected','failed')),
  reason       text,
  reference    text,
  requested_by uuid REFERENCES users(id),
  approved_by  uuid REFERENCES users(id),
  processed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

CREATE TABLE IF NOT EXISTS disputes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id),
  store_id          uuid NOT NULL REFERENCES stores(id),
  customer_id       uuid NOT NULL REFERENCES users(id),
  opened_by         uuid NOT NULL REFERENCES users(id),
  opened_by_role    text NOT NULL CHECK (opened_by_role IN ('customer','seller')),
  reason            text NOT NULL,
  description       text,
  status            text NOT NULL DEFAULT 'awaiting_vendor'
                    CHECK (status IN ('open','awaiting_vendor','awaiting_customer','under_review','resolved','closed')),
  respond_by        timestamptz,
  escalated_at      timestamptz,
  return_id         uuid REFERENCES returns(id),
  resolution        text CHECK (resolution IN ('full_refund','partial_refund','release_to_vendor','replacement')),
  resolution_amount numeric(12,2),
  resolution_notes  text,
  resolved_by       uuid REFERENCES users(id),
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_disputes_open_per_order ON disputes(order_id) WHERE status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_disputes_deadline ON disputes(respond_by) WHERE status IN ('awaiting_vendor','awaiting_customer');
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_refunds_dispute') THEN
    ALTER TABLE refunds ADD CONSTRAINT fk_refunds_dispute FOREIGN KEY (dispute_id) REFERENCES disputes(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dispute_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  sender_id   uuid NOT NULL REFERENCES users(id),
  sender_role text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispute_messages ON dispute_messages(dispute_id, created_at);

CREATE TABLE IF NOT EXISTS dispute_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id  uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES dispute_messages(id) ON DELETE SET NULL,
  url         text NOT NULL,
  public_id   text,
  mime        text,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Messaging & Q&A
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES users(id),
  store_id        uuid NOT NULL REFERENCES stores(id),
  product_id      uuid REFERENCES products(id),
  order_id        uuid REFERENCES orders(id),
  subject         text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_store ON conversations(store_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES users(id),
  sender_role     text NOT NULL CHECK (sender_role IN ('customer','seller')),
  body            text NOT NULL,
  flagged         boolean NOT NULL DEFAULT false,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS product_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  question    text NOT NULL,
  answer      text,
  answered_by uuid REFERENCES users(id),
  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_questions ON product_questions(product_id, created_at DESC);

-- ============================================================
-- Notifications & background jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text UNIQUE,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error   text,
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(run_at) WHERE status = 'queued';

-- ============================================================
-- Audit, fraud, CMS
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  actor_role  text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  signal      text NOT NULL,
  severity    text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  reviewed_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, signal)
);

CREATE TABLE IF NOT EXISTS static_pages (
  slug         text PRIMARY KEY,
  title        text NOT NULL,
  body         text NOT NULL,
  is_published boolean NOT NULL DEFAULT true,
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
