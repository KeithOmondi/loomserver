// src/features/platform/platform.seller.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db';
import { protect, requireRole } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import { audit } from '../../services/audit.service';
import { getStoreBalances } from '../../services/ledger.service';

const uuid = z.string().uuid();

// ===========================================================================
// Variants — replace the full set for a product the seller owns
// ===========================================================================
export const variantsRouter = Router();

const variantInput = z.object({
  id: uuid.optional(),
  name: z.string().min(1).max(120),
  sku: z.string().max(60).optional().nullable(),
  options: z.record(z.string(), z.string().max(60)).default({}),
  price: z.number().nonnegative(),
  compare_at_price: z.number().nonnegative().optional().nullable(),
  stock_quantity: z.number().int().nonnegative(),
  image_url: z.string().url().optional().nullable(),
  is_active: z.boolean().default(true),
});

variantsRouter.put(
  '/:productId/variants',
  protect,
  requireRole('seller'),
  validate(z.object({ params: z.object({ productId: uuid }), body: z.object({ variants: z.array(variantInput).max(100) }) })),
  asyncHandler(async (req, res) => {
    const own = await pool.query(
      `SELECT p.id FROM products p JOIN sellers s ON s.id = p.seller_id WHERE p.id = $1 AND s.user_id = $2 AND p.deleted_at IS NULL`,
      [req.params.productId, req.user!.id],
    );
    if (!own.rows[0]) throw new AppError(404, 'Product not found in your store.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const keep: string[] = [];
      let position = 0;
      for (const v of req.body.variants as z.infer<typeof variantInput>[]) {
        if (v.id) {
          const r = await client.query(
            `UPDATE product_variants SET name=$3, sku=$4, options=$5::jsonb, price=$6, compare_at_price=$7, stock_quantity=$8,
                    image_url=$9, is_active=$10, position=$11, updated_at=NOW()
             WHERE id = $1 AND product_id = $2 RETURNING id`,
            [v.id, req.params.productId, v.name, v.sku ?? null, JSON.stringify(v.options), v.price, v.compare_at_price ?? null, v.stock_quantity, v.image_url ?? null, v.is_active, position++],
          );
          if (r.rows[0]) keep.push(r.rows[0].id);
        } else {
          const r = await client.query(
            `INSERT INTO product_variants (product_id, name, sku, options, price, compare_at_price, stock_quantity, image_url, is_active, position)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [req.params.productId, v.name, v.sku ?? null, JSON.stringify(v.options), v.price, v.compare_at_price ?? null, v.stock_quantity, v.image_url ?? null, v.is_active, position++],
          );
          keep.push(r.rows[0].id);
        }
      }
      // variants removed from the list are deactivated (kept for old orders), not deleted
      await client.query(`UPDATE product_variants SET is_active = false WHERE product_id = $1 AND NOT (id = ANY($2::uuid[]))`, [req.params.productId, keep]);
      await client.query(
        `UPDATE products SET has_variants = $2,
                stock_quantity = CASE WHEN $2 THEN (SELECT COALESCE(SUM(stock_quantity),0) FROM product_variants WHERE product_id = $1 AND is_active) ELSE stock_quantity END,
                price = CASE WHEN $2 THEN (SELECT COALESCE(MIN(price), products.price) FROM product_variants WHERE product_id = $1 AND is_active) ELSE price END,
                updated_at = NOW()
         WHERE id = $1`,
        [req.params.productId, keep.length > 0],
      );
      await audit({ actorId: req.user!.id, actorRole: 'seller', action: 'product.variants_update', entityType: 'product', entityId: String(req.params.productId), metadata: { count: keep.length } }, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const out = await pool.query(`SELECT * FROM product_variants WHERE product_id = $1 AND is_active ORDER BY position`, [req.params.productId]);
    res.json({ success: true, data: out.rows });
  }),
);

// ===========================================================================
// Seller hub: store coupons + dashboard
// ===========================================================================
export const sellerHubRouter = Router();
sellerHubRouter.use(protect, requireRole('seller'));

const myStoreId = async (userId: string): Promise<string> => {
  const r = await pool.query(`SELECT st.id FROM stores st JOIN sellers s ON s.id = st.seller_id WHERE s.user_id = $1 AND st.deleted_at IS NULL ORDER BY st.created_at LIMIT 1`, [userId]);
  if (!r.rows[0]) throw new AppError(404, 'Create a store first.');
  return r.rows[0].id;
};

const couponInput = z.object({
  code: z.string().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only'),
  description: z.string().max(200).optional(),
  type: z.enum(['percent', 'fixed']),
  value: z.number().positive(),
  min_subtotal: z.number().nonnegative().default(0),
  max_discount: z.number().positive().optional().nullable(),
  starts_at: z.string().datetime().optional().nullable(),
  ends_at: z.string().datetime().optional().nullable(),
  usage_limit: z.number().int().positive().optional().nullable(),
  per_user_limit: z.number().int().positive().default(1),
});

sellerHubRouter.get('/coupons', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM coupons WHERE store_id = $1 ORDER BY created_at DESC`, [await myStoreId(req.user!.id)]);
  res.json({ success: true, data: r.rows });
}));

sellerHubRouter.post('/coupons', validate(z.object({ body: couponInput })), asyncHandler(async (req, res) => {
  const b = req.body as z.infer<typeof couponInput>;
  if (b.type === 'percent' && b.value > 90) throw new AppError(400, 'A percentage coupon cannot exceed 90%.');
  try {
    const r = await pool.query(
      `INSERT INTO coupons (code, description, type, value, min_subtotal, max_discount, scope, store_id, starts_at, ends_at, usage_limit, per_user_limit, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'store',$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.code.toUpperCase(), b.description ?? null, b.type, b.value, b.min_subtotal, b.max_discount ?? null, await myStoreId(req.user!.id), b.starts_at ?? null, b.ends_at ?? null, b.usage_limit ?? null, b.per_user_limit, req.user!.id],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e: any) {
    if (e.code === '23505') throw new AppError(409, 'That coupon code is already taken.');
    throw e;
  }
}));

sellerHubRouter.patch('/coupons/:id', validate(z.object({ params: z.object({ id: uuid }), body: z.object({ is_active: z.boolean() }) })), asyncHandler(async (req, res) => {
  const r = await pool.query(`UPDATE coupons SET is_active = $3 WHERE id = $1 AND store_id = $2 RETURNING id`, [req.params.id, await myStoreId(req.user!.id), req.body.is_active]);
  if (!r.rows[0]) throw new AppError(404, 'Coupon not found.');
  res.json({ success: true });
}));

// ----- dashboard -----
sellerHubRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const storeId = await myStoreId(req.user!.id);
  const since = new Date(Date.now() - days * 86_400_000);

  const [kpi, series, top, status, balances, lowStock] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0) AS gross, COALESCE(SUM(commission_total),0) AS commission, COALESCE(SUM(platform_delivery_fee),0) AS delivery,
              COUNT(*) FILTER (WHERE status = 'paid' OR status = 'processing')::int AS to_ship
       FROM orders WHERE store_id = $1 AND payment_status IN ('paid','partially_refunded','refunded') AND placed_at >= $2`,
      [storeId, since],
    ),
    pool.query(
      `SELECT d::date AS day, COALESCE(SUM(o.total),0) AS revenue, COUNT(o.id)::int AS orders
       FROM generate_series($2::date, CURRENT_DATE, '1 day') d
       LEFT JOIN orders o ON o.store_id = $1 AND o.placed_at::date = d::date AND o.payment_status IN ('paid','partially_refunded','refunded')
       GROUP BY d ORDER BY d`,
      [storeId, since],
    ),
    pool.query(
      `SELECT p.id, p.name, SUM(oi.quantity)::int AS units, SUM(oi.total) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
       WHERE o.store_id = $1 AND o.payment_status = 'paid' AND o.placed_at >= $2
       GROUP BY p.id ORDER BY revenue DESC LIMIT 5`,
      [storeId, since],
    ),
    pool.query(`SELECT status, COUNT(*)::int AS n FROM orders WHERE store_id = $1 AND payment_status IN ('paid','partially_refunded','refunded') GROUP BY status`, [storeId]),
    getStoreBalances(storeId),
    pool.query(`SELECT id, name, stock_quantity FROM products WHERE store_id = $1 AND deleted_at IS NULL AND status = 'active' AND stock_quantity <= low_stock_threshold ORDER BY stock_quantity LIMIT 8`, [storeId]),
  ]);

  const k = kpi.rows[0];
  res.json({
    success: true,
    data: {
      period_days: days,
      orders: k.orders,
      gross_sales: Number(k.gross),
      commission: Number(k.commission),
      net_earnings: Number(k.gross) - Number(k.commission) - Number(k.delivery),
      delivery_fees: Number(k.delivery), // collected by Loom for couriers — not part of vendor earnings
      orders_to_ship: k.to_ship,
      balances: balances,
      series: series.rows.map((r) => ({ day: r.day, revenue: Number(r.revenue), orders: r.orders })),
      top_products: top.rows.map((r) => ({ ...r, revenue: Number(r.revenue) })),
      orders_by_status: status.rows,
      low_stock: lowStock.rows,
    },
  });
}));

// ----- product questions awaiting an answer -----
sellerHubRouter.get('/questions', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT q.id, q.question, q.answer, q.created_at, p.name AS product_name, p.slug AS product_slug
     FROM product_questions q JOIN products p ON p.id = q.product_id JOIN sellers s ON s.id = p.seller_id
     WHERE s.user_id = $1 ORDER BY (q.answer IS NULL) DESC, q.created_at DESC LIMIT 100`,
    [req.user!.id],
  );
  res.json({ success: true, data: r.rows });
}));
