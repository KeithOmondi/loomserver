// src/features/orders/order-actions.routes.ts
//
// Authorised order actions. Mounted BEFORE the generic order routes so these specific paths win.
//   POST /orders/quote                       price a checkout without creating anything
//   POST /orders/:orderId/accept             seller: paid → processing
//   POST /orders/:orderId/ship               seller: add carrier + tracking, mark shipped
//   POST /orders/:orderId/deliver            seller: mark delivered (starts auto-confirm window)
//   POST /orders/:orderId/confirm-delivery   customer: confirm receipt, releases payment to vendor
//   GET  /orders/seller/mine                 seller: orders across all their stores
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db';
import { protect, requireRole } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { quoteCheckout } from './checkout.service';
import { acceptOrder, confirmDelivery, markDelivered, shipOrder } from './order-lifecycle.service';

const router = Router();

const uuid = z.string().uuid();
const orderParam = z.object({ params: z.object({ orderId: uuid }) });

const quoteSchema = z.object({
  body: z.object({
    address_id: uuid.optional(),
    shipping_address: z.object({ state: z.string().optional(), city: z.string().optional() }).passthrough().optional(),
    pickup_station_id: uuid.optional().nullable(),
    coupon_code: z.string().max(50).optional().nullable(),
  }),
});

router.post(
  '/quote',
  protect,
  validate(quoteSchema),
  asyncHandler(async (req, res) => {
    const quote = await quoteCheckout(req.user!.id, req.body);
    res.json({ success: true, data: quote });
  }),
);

router.post(
  '/:orderId/accept',
  protect,
  requireRole('seller'),
  validate(orderParam),
  asyncHandler(async (req, res) => {
    await acceptOrder(String(req.params.orderId), req.user!);
    res.json({ success: true, message: 'Order accepted.' });
  }),
);

router.post(
  '/:orderId/ship',
  protect,
  requireRole('seller'),
  validate(
    z.object({
      params: orderParam.shape.params,
      body: z.object({
        carrier: z.string().min(2).max(80),
        tracking_number: z.string().min(3).max(80),
        tracking_url: z.string().url().optional(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    await shipOrder(String(req.params.orderId), req.user!, req.body);
    res.json({ success: true, message: 'Order marked as shipped.' });
  }),
);

router.post(
  '/:orderId/deliver',
  protect,
  requireRole('seller'),
  validate(orderParam),
  asyncHandler(async (req, res) => {
    await markDelivered(String(req.params.orderId), req.user!);
    res.json({ success: true, message: 'Order marked as delivered.' });
  }),
);

router.post(
  '/:orderId/confirm-delivery',
  protect,
  validate(orderParam),
  asyncHandler(async (req, res) => {
    await confirmDelivery(String(req.params.orderId), req.user!.id);
    res.json({ success: true, message: 'Thanks for confirming. Payment has been released to the seller.' });
  }),
);

/** Real order lines (order_items ids) — needed to file a return against a specific item. */
router.get(
  '/:orderId/lines',
  protect,
  validate(orderParam),
  asyncHandler(async (req, res) => {
    const staff = ['admin', 'super_admin', 'support', 'finance'].includes(req.user!.role);
    const rows = await pool.query(
      `SELECT oi.id, oi.product_id, oi.variant_id, oi.variant_name, oi.quantity, oi.price, oi.total,
              p.name AS product_name, p.slug AS product_slug,
              (SELECT url FROM product_images WHERE product_id = p.id ORDER BY is_primary DESC, sort_order LIMIT 1) AS image,
              (SELECT status FROM returns r WHERE r.order_item_id = oi.id ORDER BY r.created_at DESC LIMIT 1) AS return_status
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       JOIN sellers s ON s.id = o.seller_id
       WHERE oi.order_id = $1 AND (o.user_id = $2 OR s.user_id = $2 OR $3::boolean)`,
      [req.params.orderId, req.user!.id, staff],
    );
    res.json({ success: true, data: rows.rows });
  }),
);

router.get(
  '/seller/mine',
  protect,
  requireRole('seller'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const status = typeof req.query.status === 'string' ? req.query.status : null;

    const where = `s.user_id = $1 AND o.deleted_at IS NULL AND o.payment_status IN ('paid','partially_refunded','refunded')
                   AND ($2::text IS NULL OR o.status = $2)`;
    const rows = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.escrow_status, o.total, o.subtotal,
              o.shipping_total, o.commission_total, o.platform_delivery_fee, o.carrier, o.tracking_number, o.items, o.customer,
              o.shipping, o.placed_at, o.shipped_at, o.delivered_at, o.auto_confirm_at, st.name AS store_name
       FROM orders o JOIN sellers s ON s.id = o.seller_id JOIN stores st ON st.id = o.store_id
       WHERE ${where}
       ORDER BY o.placed_at DESC LIMIT $3 OFFSET $4`,
      [req.user!.id, status, limit, (page - 1) * limit],
    );
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM orders o JOIN sellers s ON s.id = o.seller_id WHERE ${where}`, [req.user!.id, status]);
    res.json({
      success: true,
      data: rows.rows,
      pagination: { page, limit, total: count.rows[0].n, pages: Math.max(1, Math.ceil(count.rows[0].n / limit)) },
    });
  }),
);

export default router;
