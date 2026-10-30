// src/features/orders/checkout.service.ts
//
// Turns a cart into one order per vendor. Everything money-related is recomputed here from live
// data (never trusted from the cart): current prices, flash-sale prices, stock, delivery zone,
// coupons and commission. `quoteCheckout` runs the same plan without writing anything, so the
// web checkout can show exact totals before the customer pays.
import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import { allocate, couponDiscount, fromCents, round2, shippingFee, splitOrder, toCents } from '../../services/money';
import { getNumberSetting, getSetting } from '../../services/settings.service';
import { Order } from './order.types';
import { generateOrderNumber, mapRowToOrder, resolveShippingAddress } from './order.service';
import { CheckoutBody } from './order.validator';
import { flagOrderSignals } from '../../services/fraud.service';

const CURRENCY = 'KES';

interface CartLine {
  cart_item_id: string;
  cart_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  product_name: string;
  product_slug: string;
  product_sku: string | null;
  product_image: string | null;
  product_status: string;
  product_is_active: boolean;
  product_price: string;
  product_stock: number;
  allow_backorders: boolean;
  weight: string | null;
  category_id: string | null;
  store_id: string;
  seller_id: string;
  seller_commission: string | null;
  category_commission: string | null;
  variant_name: string | null;
  variant_price: string | null;
  variant_stock: number | null;
  variant_active: boolean | null;
  flash_price: string | null;
  flash_remaining: number | null;
}

interface PlannedItem {
  line: CartLine;
  unitPrice: number;
  lineTotal: number;
  ratePct: number;
}

interface CouponRow {
  id: string;
  code: string;
  type: 'percent' | 'fixed';
  value: string;
  min_subtotal: string;
  max_discount: string | null;
  scope: 'platform' | 'store';
  store_id: string | null;
  usage_limit: number | null;
  used_count: number;
  per_user_limit: number;
}

interface StorePlan {
  storeId: string;
  sellerId: string;
  items: PlannedItem[];
  subtotal: number;
  shipping: number;
  zoneName: string | null;
  estDays: { min: number; max: number };
  vendorDiscount: number;
  platformDiscount: number;
  /** delivery fee kept by Loom for couriers (0 when vendors deliver) */
  platformDelivery: number;
  customerPays: number;
  commission: number;
  vendorAmount: number;
}

interface Plan {
  stores: StorePlan[];
  coupon: CouponRow | null;
  couponDiscountTotal: number;
  grandTotal: number;
  pickupStationId: string | null;
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

const loadCoupon = async (client: PoolClient, code: string, userId: string): Promise<CouponRow> => {
  const res = await client.query<CouponRow>(
    `SELECT * FROM coupons
     WHERE upper(code) = upper($1) AND is_active = true
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at >= NOW())`,
    [code.trim()],
  );
  const coupon = res.rows[0];
  if (!coupon) throw new AppError(400, 'This coupon code is invalid or has expired.');
  if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) {
    throw new AppError(400, 'This coupon has reached its usage limit.');
  }
  const used = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2`,
    [coupon.id, userId],
  );
  if (used.rows[0].n >= coupon.per_user_limit) {
    throw new AppError(400, 'You have already used this coupon.');
  }
  return coupon;
};

// ---------------------------------------------------------------------------
// Planning (shared by quote and create)
// ---------------------------------------------------------------------------

const buildPlan = async (
  client: PoolClient,
  userId: string,
  body: Pick<CheckoutBody, 'address_id' | 'shipping_address'> & { coupon_code?: string | null; pickup_station_id?: string | null },
  opts: { lock: boolean },
): Promise<{ plan: Plan; lines: CartLine[]; buyer: { full_name: string; email: string; phone: string | null } }> => {
  const buyerRes = await client.query(`SELECT id, full_name, email, phone FROM users WHERE id = $1`, [userId]);
  if (buyerRes.rows.length === 0) throw new AppError(404, 'User not found.');
  const buyer = buyerRes.rows[0];

  const cart = await client.query<CartLine>(
    `SELECT ci.id AS cart_item_id, ci.cart_id, ci.product_id, ci.variant_id, ci.quantity,
            p.name AS product_name, p.slug AS product_slug, p.sku AS product_sku,
            p.status AS product_status, p.is_active AS product_is_active,
            p.price AS product_price, p.stock_quantity AS product_stock, p.allow_backorders,
            p.weight, p.category_id, st.id AS store_id, st.seller_id,
            s.custom_commission_rate AS seller_commission,
            cat.commission_rate AS category_commission,
            pv.name AS variant_name, pv.price AS variant_price,
            pv.stock_quantity AS variant_stock, pv.is_active AS variant_active,
            img.url AS product_image,
            fl.sale_price AS flash_price,
            CASE WHEN fl.quantity_limit IS NULL THEN NULL ELSE fl.quantity_limit - fl.sold END AS flash_remaining
     FROM carts c
     JOIN cart_items ci ON ci.cart_id = c.id
     JOIN products p ON p.id = ci.product_id
     JOIN stores st ON st.id = p.store_id
     JOIN sellers s ON s.id = st.seller_id
     LEFT JOIN categories cat ON cat.id = p.category_id
     LEFT JOIN product_variants pv ON pv.id = ci.variant_id
     LEFT JOIN LATERAL (
       SELECT url FROM product_images WHERE product_id = p.id
       ORDER BY is_primary DESC, sort_order ASC, created_at ASC LIMIT 1
     ) img ON TRUE
     LEFT JOIN LATERAL (
       SELECT fi.sale_price, fi.quantity_limit, fi.sold
       FROM flash_sale_items fi JOIN flash_sales fs ON fs.id = fi.flash_sale_id
       WHERE fi.product_id = p.id AND fs.is_active AND fs.starts_at <= NOW() AND fs.ends_at >= NOW()
       ORDER BY fi.sale_price ASC LIMIT 1
     ) fl ON TRUE
     WHERE c.user_id = $1 AND p.deleted_at IS NULL
     ${opts.lock ? 'FOR UPDATE OF p' : ''}`,
    [userId],
  );
  if (cart.rows.length === 0) throw new AppError(400, 'Your cart is empty.');

  const defaultRate = await getNumberSetting('commission.default_rate', 10);

  // ---- validate + price every line from live data ----
  const planned: PlannedItem[] = cart.rows.map((line) => {
    if (!line.product_is_active || line.product_status !== 'active') {
      throw new AppError(400, `"${line.product_name}" is no longer available. Please remove it from your cart.`);
    }
    if (line.variant_id && (!line.variant_name || line.variant_active === false)) {
      throw new AppError(400, `The selected option of "${line.product_name}" is no longer available.`);
    }
    const stock = line.variant_id ? line.variant_stock ?? 0 : line.product_stock;
    if (!line.allow_backorders && stock < line.quantity) {
      throw new AppError(400, `Insufficient stock for "${line.product_name}". Available: ${stock}.`);
    }

    let unit = Number(line.variant_id ? line.variant_price : line.product_price);
    if (!line.variant_id && line.flash_price != null) {
      if (line.flash_remaining != null && line.flash_remaining < line.quantity) {
        throw new AppError(400, `Flash-sale stock for "${line.product_name}" is limited to ${Math.max(0, line.flash_remaining)}.`);
      }
      unit = Math.min(unit, Number(line.flash_price));
    }

    const ratePct = Number(line.seller_commission ?? line.category_commission ?? defaultRate);
    return { line, unitPrice: round2(unit), lineTotal: round2(unit * line.quantity), ratePct };
  });

  // ---- delivery destination ----
  let county: string | null = null;
  let area: string | null = null; // neighbourhood — matched before county so Nairobi areas can price differently
  let pickupStation: { id: string; fee: number; county: string } | null = null;
  if (body.pickup_station_id) {
    const ps = await client.query(
      `SELECT id, fee, county FROM pickup_stations WHERE id = $1 AND is_active = true`,
      [body.pickup_station_id],
    );
    if (!ps.rows[0]) throw new AppError(400, 'That pickup station is not available.');
    pickupStation = { id: ps.rows[0].id, fee: Number(ps.rows[0].fee), county: ps.rows[0].county };
    county = pickupStation.county;
  } else {
    const addr = await resolveShippingAddress(client, userId, body as CheckoutBody, buyer);
    county = addr.state ?? addr.city ?? null;
    area = addr.city ?? null;
  }

  const zones = (
    await client.query(
      `SELECT * FROM shipping_zones WHERE is_active = true ORDER BY base_fee ASC`,
    )
  ).rows;
  const norm = (s: string) => s.trim().toLowerCase();
  const zone =
    (area && zones.find((z) => ((z.areas ?? []) as string[]).some((a) => norm(a) === norm(area!)))) ||
    (county ? zones.find((z) => (z.counties as string[]).some((c) => norm(c) === norm(county!))) : undefined);
  const deliveryHandledBy = await getSetting<string>('delivery.handled_by', 'platform');
  const defaultFee = await getNumberSetting('shipping.default_fee', 300);
  const globalFreeOver = await getSetting<number | null>('shipping.free_over', null);

  // ---- group by store ----
  const byStore = new Map<string, PlannedItem[]>();
  for (const it of planned) {
    const arr = byStore.get(it.line.store_id) ?? [];
    arr.push(it);
    byStore.set(it.line.store_id, arr);
  }

  const storeSubtotals = [...byStore.values()].map((items) => items.reduce((s, i) => s + toCents(i.lineTotal), 0));
  const allSubtotal = storeSubtotals.reduce((a, b) => a + b, 0);

  // ---- coupon ----
  const coupon = body.coupon_code ? await loadCoupon(client, body.coupon_code, userId) : null;
  const storeIds = [...byStore.keys()];
  const vendorDiscountCents = storeIds.map(() => 0);
  const platformDiscountCents = storeIds.map(() => 0);
  let couponTotalCents = 0;

  if (coupon) {
    if (coupon.scope === 'store') {
      const idx = storeIds.indexOf(coupon.store_id!);
      if (idx === -1) throw new AppError(400, 'This coupon only applies to items from a specific store.');
      if (fromCents(storeSubtotals[idx]) < Number(coupon.min_subtotal)) {
        throw new AppError(400, `Spend at least KSh ${Number(coupon.min_subtotal)} at that store to use this coupon.`);
      }
      const d = toCents(couponDiscount({ type: coupon.type, value: Number(coupon.value), base: fromCents(storeSubtotals[idx]), maxDiscount: coupon.max_discount ? Number(coupon.max_discount) : null }));
      vendorDiscountCents[idx] = d;
      couponTotalCents = d;
    } else {
      if (fromCents(allSubtotal) < Number(coupon.min_subtotal)) {
        throw new AppError(400, `Spend at least KSh ${Number(coupon.min_subtotal)} to use this coupon.`);
      }
      const d = toCents(couponDiscount({ type: coupon.type, value: Number(coupon.value), base: fromCents(allSubtotal), maxDiscount: coupon.max_discount ? Number(coupon.max_discount) : null }));
      allocate(d, storeSubtotals).forEach((share, i) => (platformDiscountCents[i] = share));
      couponTotalCents = d;
    }
  }

  // ---- per-store money ----
  const stores: StorePlan[] = storeIds.map((storeId, idx) => {
    const items = byStore.get(storeId)!;
    const subtotal = fromCents(storeSubtotals[idx]);
    const weight = items.reduce((s, i) => s + Number(i.line.weight ?? 0) * i.line.quantity, 0);

    let shipping: number;
    if (pickupStation) {
      shipping = pickupStation.fee;
    } else if (zone) {
      shipping = shippingFee({
        baseFee: Number(zone.base_fee),
        perKgFee: Number(zone.per_kg_fee),
        weightKg: weight,
        subtotal,
        freeOver: zone.free_over != null ? Number(zone.free_over) : globalFreeOver,
      });
    } else {
      shipping = globalFreeOver != null && subtotal >= globalFreeOver ? 0 : defaultFee;
    }

    const money = splitOrder({
      items: items.map((i) => ({ lineTotal: i.lineTotal, ratePct: i.ratePct })),
      shipping,
      vendorDiscount: fromCents(vendorDiscountCents[idx]),
      platformDiscount: fromCents(platformDiscountCents[idx]),
      shippingToPlatform: deliveryHandledBy === 'platform',
    });

    return {
      storeId,
      sellerId: items[0].line.seller_id,
      items,
      subtotal,
      shipping,
      zoneName: zone?.name ?? null,
      estDays: { min: zone?.est_days_min ?? 2, max: zone?.est_days_max ?? 5 },
      vendorDiscount: fromCents(vendorDiscountCents[idx]),
      platformDiscount: fromCents(platformDiscountCents[idx]),
      platformDelivery: money.delivery,
      customerPays: money.customerPays,
      commission: money.commission,
      vendorAmount: money.vendorAmount,
    };
  });

  const grandTotal = round2(stores.reduce((s, p) => s + p.customerPays, 0));
  return {
    plan: { stores, coupon, couponDiscountTotal: fromCents(couponTotalCents), grandTotal, pickupStationId: pickupStation?.id ?? null },
    lines: cart.rows,
    buyer,
  };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CheckoutQuote {
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  coupon_code: string | null;
  orders: { store_id: string; subtotal: number; shipping: number; discount: number; total: number; est_days: { min: number; max: number } }[];
}

export const quoteCheckout = async (
  userId: string,
  body: Parameters<typeof buildPlan>[2],
): Promise<CheckoutQuote> => {
  const client = await pool.connect();
  try {
    const { plan } = await buildPlan(client, userId, body, { lock: false });
    return {
      subtotal: round2(plan.stores.reduce((s, p) => s + p.subtotal, 0)),
      shipping: round2(plan.stores.reduce((s, p) => s + p.shipping, 0)),
      discount: plan.couponDiscountTotal,
      total: plan.grandTotal,
      coupon_code: plan.coupon?.code ?? null,
      orders: plan.stores.map((p) => ({
        store_id: p.storeId,
        subtotal: p.subtotal,
        shipping: p.shipping,
        discount: round2(p.vendorDiscount + p.platformDiscount),
        total: p.customerPays,
        est_days: p.estDays,
      })),
    };
  } finally {
    client.release();
  }
};

export const createOrdersFromCart = async (
  userId: string,
  checkout: CheckoutBody & { coupon_code?: string | null; pickup_station_id?: string | null },
): Promise<{ orders: Order[]; total: number; currency: string; payment_group_id: string }> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { plan, lines, buyer } = await buildPlan(client, userId, checkout, { lock: true });
    const shippingAddress = checkout.pickup_station_id
      ? await pickupAddress(client, checkout.pickup_station_id, buyer)
      : await resolveShippingAddress(client, userId, checkout, buyer);

    const paymentGroupId = (await client.query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`)).rows[0].id;
    const [firstName, ...rest] = (buyer.full_name || '').split(' ');
    const customerSnapshot = { first_name: firstName ?? '', last_name: rest.join(' '), email: buyer.email, phone: buyer.phone ?? '' };
    const expiryMinutes = await getNumberSetting('orders.unpaid_expiry_minutes', 30);

    const created: Order[] = [];
    for (const sp of plan.stores) {
      const orderNumber = await generateOrderNumber(client);
      const orderItemsJson = sp.items.map((i) => ({
        id: i.line.cart_item_id,
        order_id: '',
        product_id: i.line.product_id,
        variant_id: i.line.variant_id ?? undefined,
        product_name: i.line.product_name,
        variant_name: i.line.variant_name ?? undefined,
        sku: i.line.product_sku ?? '',
        quantity: i.line.quantity,
        price: i.unitPrice,
        total: i.lineTotal,
        discount_amount: 0,
        tax_amount: 0,
        tax_rate: 0,
        metadata: { image: i.line.product_image, slug: i.line.product_slug },
      }));

      const shippingSnapshot = {
        method: checkout.pickup_station_id ? 'pickup' : 'standard',
        cost: sp.shipping,
        estimated_days: sp.estDays.max,
        zone: sp.zoneName,
        address: shippingAddress,
      };
      const paymentSnapshot = { method: 'mpesa', status: 'pending', amount: sp.customerPays, currency: CURRENCY };

      const orderRes = await client.query(
        `INSERT INTO orders (
           order_number, store_id, user_id, seller_id, customer, items, subtotal,
           discount_total, vendor_discount, platform_discount, tax_total, shipping_total, total,
           commission_total, currency, shipping, payment, status, fulfillment_status, payment_status,
           customer_notes, coupon_code, pickup_station_id, placed_at, expires_at, created_at, updated_at,
           payment_group_id, platform_delivery_fee
         ) VALUES (
           $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,
           $8,$9,$10,0,$11,$12,
           $13,$14,$15::jsonb,$16::jsonb,'pending','unfulfilled','pending',
           $17,$18,$19,NOW(), NOW() + ($20 || ' minutes')::interval, NOW(), NOW(),
           $21, $22
         ) RETURNING *`,
        [
          orderNumber, sp.storeId, userId, sp.sellerId, JSON.stringify(customerSnapshot), JSON.stringify(orderItemsJson), sp.subtotal,
          round2(sp.vendorDiscount + sp.platformDiscount), sp.vendorDiscount, sp.platformDiscount, sp.shipping, sp.customerPays,
          sp.commission, CURRENCY, JSON.stringify(shippingSnapshot), JSON.stringify(paymentSnapshot),
          checkout.customer_notes ?? null, plan.coupon?.code ?? null, plan.pickupStationId, String(expiryMinutes),
          paymentGroupId, sp.platformDelivery,
        ],
      );
      const order = mapRowToOrder(orderRes.rows[0]);
      created.push(order);

      for (const i of sp.items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, variant_id, variant_name, quantity, price, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [order.id, i.line.product_id, i.line.variant_id, i.line.variant_name, i.line.quantity, i.unitPrice, i.lineTotal],
        );
        // reserve stock (restored if the order expires, fails or is cancelled)
        if (i.line.variant_id) {
          await client.query(`UPDATE product_variants SET stock_quantity = stock_quantity - $1, updated_at = NOW() WHERE id = $2`, [i.line.quantity, i.line.variant_id]);
        } else {
          await client.query(`UPDATE products SET stock_quantity = stock_quantity - $1, updated_at = NOW() WHERE id = $2`, [i.line.quantity, i.line.product_id]);
          if (i.line.flash_price != null) {
            await client.query(
              `UPDATE flash_sale_items fi SET sold = sold + $1
               FROM flash_sales fs WHERE fs.id = fi.flash_sale_id AND fi.product_id = $2
                 AND fs.is_active AND fs.starts_at <= NOW() AND fs.ends_at >= NOW()`,
              [i.line.quantity, i.line.product_id],
            );
          }
        }
      }

      if (plan.coupon && (sp.vendorDiscount > 0 || sp.platformDiscount > 0)) {
        await client.query(
          `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, amount) VALUES ($1,$2,$3,$4)`,
          [plan.coupon.id, userId, order.id, round2(sp.vendorDiscount + sp.platformDiscount)],
        );
      }
    }

    if (plan.coupon) await client.query(`UPDATE coupons SET used_count = used_count + 1 WHERE id = $1`, [plan.coupon.id]);
    await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [lines[0].cart_id]);

    await client.query('COMMIT');

    void flagOrderSignals(userId, created.map((o) => o.id)); // best-effort, after commit
    return { orders: created, total: plan.grandTotal, currency: CURRENCY, payment_group_id: paymentGroupId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const pickupAddress = async (client: PoolClient, stationId: string, buyer: { full_name: string; email: string; phone: string | null }) => {
  const ps = (await client.query(`SELECT * FROM pickup_stations WHERE id = $1`, [stationId])).rows[0];
  const [first, ...rest] = (buyer.full_name || '').split(' ');
  return {
    first_name: first ?? '',
    last_name: rest.join(' '),
    email: buyer.email,
    phone: buyer.phone ?? ps.phone ?? '',
    address_line1: `Pickup: ${ps.name}`,
    address_line2: ps.address,
    city: ps.county,
    state: ps.county,
    postal_code: '00100',
    country: 'KE',
  };
};
