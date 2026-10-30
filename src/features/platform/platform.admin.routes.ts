// src/features/platform/platform.admin.routes.ts
//
// Back-office API. Access: admin/super_admin everywhere; finance for money views and reports;
// support for orders/disputes/fraud views. Settings and content are admin-only.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db';
import { protect, requireAdmin, requireStaff } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import { auditFromReq } from '../../services/audit.service';
import { ACCOUNTS, getBalance, verifyLedgerBalanced } from '../../services/ledger.service';
import { listSettings, setSetting } from '../../services/settings.service';
import { toCsv } from '../payouts/payouts.service';

const uuid = z.string().uuid();
const idParam = z.object({ params: z.object({ id: uuid }) });
const router = Router();
router.use(protect, requireStaff('finance', 'support'));

const num = (v: unknown) => Number(v ?? 0);

// ===========================================================================
// Dashboard
// ===========================================================================
router.get('/dashboard', asyncHandler(async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86_400_000);

  const [orders, series, byStatus, vendors, users, disputes, refunds, payouts, holds, fraud, ledger] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0) AS gmv, COALESCE(SUM(commission_total),0) AS commission_booked
       FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded') AND placed_at >= $1`, [since]),
    pool.query(
      `SELECT d::date AS day, COALESCE(SUM(o.total),0) AS gmv, COUNT(o.id)::int AS orders
       FROM generate_series($1::date, CURRENT_DATE, '1 day') d
       LEFT JOIN orders o ON o.placed_at::date = d::date AND o.payment_status IN ('paid','partially_refunded','refunded')
       GROUP BY d ORDER BY d`, [since]),
    pool.query(`SELECT status, COUNT(*)::int AS n FROM orders WHERE payment_status IN ('paid','partially_refunded','refunded') AND placed_at >= $1 GROUP BY status ORDER BY n DESC`, [since]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*)::int AS total FROM stores WHERE deleted_at IS NULL`),
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at >= $1)::int AS new FROM users WHERE role = 'customer'`, [since]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS open, COUNT(*) FILTER (WHERE status = 'under_review')::int AS needs_review FROM disputes`),
    pool.query(`SELECT COUNT(*)::int AS pending, COALESCE(SUM(amount),0) AS amount FROM refunds WHERE status = 'pending'`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'processing')::int AS processing, COALESCE(SUM(amount) FILTER (WHERE status = 'processing'),0) AS amount FROM payouts`),
    pool.query(`SELECT COUNT(*)::int AS n FROM balance_holds WHERE active`),
    pool.query(`SELECT COUNT(*)::int AS n FROM fraud_flags WHERE status = 'open'`),
    Promise.all([getBalance(ACCOUNTS.commissionRevenue.code), getBalance(ACCOUNTS.commissionPending.code), getBalance(ACCOUNTS.deliveryRevenue.code), getBalance(ACCOUNTS.deliveryPending.code)]),
  ]);

  const o = orders.rows[0];
  res.json({
    success: true,
    data: {
      period_days: days,
      gmv: num(o.gmv),
      orders: o.orders,
      average_order_value: o.orders ? num(o.gmv) / o.orders : 0,
      commission_earned: ledger[0], // recognised revenue (released escrow)
      commission_in_escrow: ledger[1],
      delivery_fees_collected: ledger[2], // kept by Loom to pay couriers
      delivery_fees_in_escrow: ledger[3],
      active_vendors: vendors.rows[0].active,
      total_vendors: vendors.rows[0].total,
      customers: users.rows[0].total,
      new_customers: users.rows[0].new,
      open_disputes: disputes.rows[0].open,
      disputes_needing_review: disputes.rows[0].needs_review,
      pending_refunds: refunds.rows[0].pending,
      pending_refunds_amount: num(refunds.rows[0].amount),
      payouts_processing: payouts.rows[0].processing,
      payouts_processing_amount: num(payouts.rows[0].amount),
      balance_holds: holds.rows[0].n,
      open_fraud_flags: fraud.rows[0].n,
      series: series.rows.map((r) => ({ day: r.day, gmv: num(r.gmv), orders: r.orders })),
      orders_by_status: byStatus.rows,
    },
  });
}));

// ===========================================================================
// Escrow & ledger (finance)
// ===========================================================================
router.get('/escrow', requireStaff('finance'), asyncHandler(async (_req, res) => {
  const [totals, rows, balanced, wallets] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(vendor_amount - refunded_vendor) FILTER (WHERE status IN ('held','partially_refunded')),0) AS vendor_held,
              COALESCE(SUM(commission_amount - refunded_commission) FILTER (WHERE status IN ('held','partially_refunded')),0) AS commission_held,
              COALESCE(SUM(delivery_amount - refunded_delivery) FILTER (WHERE status IN ('held','partially_refunded')),0) AS delivery_held,
              COUNT(*) FILTER (WHERE status IN ('held','partially_refunded'))::int AS held_orders,
              COUNT(*) FILTER (WHERE dispute_locked)::int AS locked_orders
       FROM escrow_holds`),
    pool.query(
      `SELECT e.order_id, o.order_number, st.name AS store_name, e.status, e.vendor_amount, e.commission_amount, e.release_after, e.dispute_locked, o.status AS order_status
       FROM escrow_holds e JOIN orders o ON o.id = e.order_id JOIN stores st ON st.id = e.store_id
       WHERE e.status IN ('held','partially_refunded') ORDER BY e.release_after NULLS LAST, e.created_at LIMIT 200`),
    verifyLedgerBalanced(),
    pool.query(`SELECT COALESCE(SUM(balance),0) AS total FROM ledger_balances WHERE code LIKE 'customer:%:wallet'`),
  ]);
  const t = totals.rows[0];
  const availableToVendors = await pool.query(`SELECT COALESCE(SUM(balance),0) AS total FROM ledger_balances WHERE code LIKE 'store:%:available'`);
  res.json({
    success: true,
    data: {
      vendor_held: num(t.vendor_held), commission_held: num(t.commission_held), delivery_held: num(t.delivery_held), held_orders: t.held_orders, locked_orders: t.locked_orders,
      vendors_available: num(availableToVendors.rows[0].total), customer_wallets: num(wallets.rows[0].total),
      mpesa_clearing: await getBalance(ACCOUNTS.mpesa.code), payouts_in_transit: await getBalance(ACCOUNTS.payoutsClearing.code),
      ledger_balanced: balanced.balanced, ledger_difference: balanced.difference,
      holds: rows.rows,
    },
  });
}));

router.get('/ledger', requireStaff('finance'), asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const rows = await pool.query(
    `SELECT t.id, t.type, t.description, t.created_at, t.reference_type, t.reference_id,
            json_agg(json_build_object('account', a.code, 'direction', e.direction, 'amount', e.amount) ORDER BY e.id) AS entries
     FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id
     WHERE ($1::text IS NULL OR t.type = $1)
     GROUP BY t.id ORDER BY t.created_at DESC LIMIT $2`,
    [typeof req.query.type === 'string' ? req.query.type : null, limit],
  );
  res.json({ success: true, data: rows.rows });
}));

router.get('/audit-logs', asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100);
  const r = await pool.query(
    `SELECT l.*, u.full_name AS actor_name FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
     WHERE ($1::text IS NULL OR l.action LIKE $1 || '%') AND ($2::text IS NULL OR l.entity_id = $2)
     ORDER BY l.created_at DESC LIMIT $3`,
    [typeof req.query.action === 'string' ? req.query.action : null, typeof req.query.entity_id === 'string' ? req.query.entity_id : null, limit],
  );
  res.json({ success: true, data: r.rows });
}));

// ===========================================================================
// Orders (support view)
// ===========================================================================
router.get('/orders', asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' && req.query.q ? `%${req.query.q}%` : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const r = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.escrow_status, o.total, o.placed_at, st.name AS store_name, u.full_name AS customer_name, u.email AS customer_email
     FROM orders o JOIN stores st ON st.id = o.store_id JOIN users u ON u.id = o.user_id
     WHERE o.payment_status IN ('paid','partially_refunded','refunded') AND ($1::text IS NULL OR o.order_number ILIKE $1 OR u.email ILIKE $1 OR st.name ILIKE $1) AND ($2::text IS NULL OR o.status = $2)
     ORDER BY o.placed_at DESC LIMIT 50 OFFSET $3`,
    [q, status, (page - 1) * 50],
  );
  res.json({ success: true, data: r.rows });
}));

// ===========================================================================
// Fraud
// ===========================================================================
router.get('/fraud', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM fraud_flags WHERE ($1::text IS NULL OR status = $1) ORDER BY (severity = 'high') DESC, created_at DESC LIMIT 200`, [typeof req.query.status === 'string' ? req.query.status : 'open']);
  res.json({ success: true, data: r.rows });
}));

router.post('/fraud/:id/review', validate(z.object({ params: idParam.shape.params, body: z.object({ status: z.enum(['reviewed', 'dismissed']) }) })), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE fraud_flags SET status = $2, reviewed_by = $3 WHERE id = $1`, [req.params.id, req.body.status, req.user!.id]);
  await auditFromReq(req, 'fraud.review', 'fraud_flag', String(req.params.id), { status: req.body.status });
  res.json({ success: true });
}));

// ===========================================================================
// Reports (CSV)
// ===========================================================================
const REPORTS: Record<string, { header: string[]; sql: string }> = {
  orders: {
    header: ['Order', 'Date', 'Store', 'Customer', 'Status', 'Payment', 'Items', 'Shipping', 'Discount', 'Total', 'Commission'],
    sql: `SELECT o.order_number, o.placed_at, st.name, u.email, o.status, o.payment_status, o.subtotal, o.shipping_total, o.discount_total, o.total, o.commission_total
          FROM orders o JOIN stores st ON st.id = o.store_id JOIN users u ON u.id = o.user_id
          WHERE o.placed_at >= $1 AND o.placed_at < $2 AND o.payment_status IN ('paid','partially_refunded','refunded') ORDER BY o.placed_at`,
  },
  commissions: {
    header: ['Order', 'Released', 'Store', 'Order total', 'Commission', 'Vendor amount'],
    sql: `SELECT o.order_number, e.released_at, st.name, o.total, e.commission_amount, e.vendor_amount
          FROM escrow_holds e JOIN orders o ON o.id = e.order_id JOIN stores st ON st.id = e.store_id
          WHERE e.status = 'released' AND e.released_at >= $1 AND e.released_at < $2 ORDER BY e.released_at`,
  },
  payouts: {
    header: ['Date', 'Store', 'Method', 'Amount', 'Status', 'Reference'],
    sql: `SELECT p.created_at, st.name, p.method, p.amount, p.status, COALESCE(p.reference,'') FROM payouts p JOIN stores st ON st.id = p.store_id
          WHERE p.created_at >= $1 AND p.created_at < $2 ORDER BY p.created_at`,
  },
  refunds: {
    header: ['Date', 'Order', 'Store', 'Customer', 'Amount', 'Method', 'Status', 'Reason'],
    sql: `SELECT r.created_at, o.order_number, st.name, u.email, r.amount, r.method, r.status, COALESCE(r.reason,'')
          FROM refunds r JOIN orders o ON o.id = r.order_id JOIN stores st ON st.id = r.store_id JOIN users u ON u.id = r.user_id
          WHERE r.created_at >= $1 AND r.created_at < $2 ORDER BY r.created_at`,
  },
  vendors: {
    header: ['Store', 'Joined', 'Status', 'Orders (paid)', 'Gross sales', 'Commission'],
    sql: `SELECT st.name, st.created_at, st.status,
                 COUNT(o.id) FILTER (WHERE o.payment_status = 'paid' AND o.placed_at >= $1 AND o.placed_at < $2),
                 COALESCE(SUM(o.total) FILTER (WHERE o.payment_status = 'paid' AND o.placed_at >= $1 AND o.placed_at < $2),0),
                 COALESCE(SUM(o.commission_total) FILTER (WHERE o.payment_status = 'paid' AND o.placed_at >= $1 AND o.placed_at < $2),0)
          FROM stores st LEFT JOIN orders o ON o.store_id = st.id WHERE st.deleted_at IS NULL GROUP BY st.id ORDER BY 5 DESC`,
  },
  ledger: {
    header: ['Date', 'Type', 'Account', 'Direction', 'Amount', 'Description'],
    sql: `SELECT e.created_at, t.type, a.code, e.direction, e.amount, COALESCE(t.description,'')
          FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id
          WHERE e.created_at >= $1 AND e.created_at < $2 ORDER BY e.created_at, e.id`,
  },
};

router.get('/reports/:type.csv', requireStaff('finance'), asyncHandler(async (req, res) => {
  const report = REPORTS[String(req.params.type)];
  if (!report) throw new AppError(404, `Unknown report. Available: ${Object.keys(REPORTS).join(', ')}`);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86_400_000);
  const rows = await pool.query({ text: report.sql, values: [from, new Date(to.getTime() + 86_400_000)], rowMode: 'array' });
  const csv = toCsv(report.header, rows.rows.map((r: unknown[]) => r.map((v) => (v instanceof Date ? v.toISOString() : (v as string | number) ?? ''))));
  await auditFromReq(req, 'report.export', 'report', String(req.params.type), { from, to });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="loom-${req.params.type}-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// ===========================================================================
// Everything below: admin only
// ===========================================================================
router.use(requireAdmin);

// ----- settings -----
router.get('/settings', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await listSettings() });
}));

router.put('/settings/:key', validate(z.object({ params: z.object({ key: z.string().max(80) }), body: z.object({ value: z.unknown() }) })), asyncHandler(async (req, res) => {
  const key = String(req.params.key);
  const v = req.body.value;
  const numeric = ['commission.default_rate', 'payout.minimum_amount', 'returns.window_days', 'escrow.auto_confirm_days', 'disputes.response_hours', 'orders.unpaid_expiry_minutes', 'shipping.default_fee'];
  if (numeric.includes(key) && !(typeof v === 'number' && v >= 0)) throw new AppError(400, 'This setting must be a non-negative number.');
  if (key === 'commission.default_rate' && (v as number) > 60) throw new AppError(400, 'Commission cannot exceed 60%.');
  if (key === 'delivery.handled_by' && !['platform', 'vendor'].includes(v as string)) throw new AppError(400, 'Delivery must be handled by "platform" or "vendor".');
  if (key === 'payout.default_schedule' && !['weekly', 'monthly'].includes(v as string)) throw new AppError(400, 'Schedule must be weekly or monthly.');
  await setSetting(key, v, req.user!.id);
  await auditFromReq(req, 'settings.update', 'setting', key, { value: v });
  res.json({ success: true });
}));

router.patch('/categories/:id/commission', validate(z.object({ params: idParam.shape.params, body: z.object({ rate: z.number().min(0).max(60).nullable() }) })), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE categories SET commission_rate = $2 WHERE id = $1`, [req.params.id, req.body.rate]);
  await auditFromReq(req, 'commission.category', 'category', String(req.params.id), { rate: req.body.rate });
  res.json({ success: true });
}));

router.patch('/sellers/:id/commission', validate(z.object({ params: idParam.shape.params, body: z.object({ rate: z.number().min(0).max(60).nullable() }) })), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE sellers SET custom_commission_rate = $2 WHERE id = $1`, [req.params.id, req.body.rate]);
  await auditFromReq(req, 'commission.seller', 'seller', String(req.params.id), { rate: req.body.rate });
  res.json({ success: true });
}));

router.get('/categories-commission', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT id, name, depth, commission_rate FROM categories WHERE status = 'active' ORDER BY path`);
  res.json({ success: true, data: r.rows });
}));

router.get('/stores', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT id, name FROM stores WHERE deleted_at IS NULL ORDER BY name`);
  res.json({ success: true, data: r.rows });
}));

router.get('/sellers-commission', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT s.id, COALESCE(s.trading_name, s.business_name) AS name, s.custom_commission_rate FROM sellers s ORDER BY name`);
  res.json({ success: true, data: r.rows });
}));

// ----- coupons (platform-wide) -----
const couponBody = z.object({
  code: z.string().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/),
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

router.get('/coupons', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT c.*, st.name AS store_name FROM coupons c LEFT JOIN stores st ON st.id = c.store_id ORDER BY c.created_at DESC LIMIT 200`);
  res.json({ success: true, data: r.rows });
}));

router.post('/coupons', validate(z.object({ body: couponBody })), asyncHandler(async (req, res) => {
  const b = req.body as z.infer<typeof couponBody>;
  if (b.type === 'percent' && b.value > 90) throw new AppError(400, 'A percentage coupon cannot exceed 90%.');
  try {
    const r = await pool.query(
      `INSERT INTO coupons (code, description, type, value, min_subtotal, max_discount, scope, starts_at, ends_at, usage_limit, per_user_limit, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'platform',$7,$8,$9,$10,$11) RETURNING *`,
      [b.code.toUpperCase(), b.description ?? null, b.type, b.value, b.min_subtotal, b.max_discount ?? null, b.starts_at ?? null, b.ends_at ?? null, b.usage_limit ?? null, b.per_user_limit, req.user!.id],
    );
    await auditFromReq(req, 'coupon.create', 'coupon', r.rows[0].id, { code: b.code });
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (e: any) {
    if (e.code === '23505') throw new AppError(409, 'That coupon code is already taken.');
    throw e;
  }
}));

router.patch('/coupons/:id', validate(z.object({ params: idParam.shape.params, body: z.object({ is_active: z.boolean() }) })), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE coupons SET is_active = $2 WHERE id = $1`, [req.params.id, req.body.is_active]);
  await auditFromReq(req, 'coupon.toggle', 'coupon', String(req.params.id), req.body);
  res.json({ success: true });
}));

// ----- flash sales -----
router.get('/flash-sales', asyncHandler(async (_req, res) => {
  const r = await pool.query(
    `SELECT fs.*, COALESCE(json_agg(json_build_object('product_id', fi.product_id, 'name', p.name, 'price', p.price, 'sale_price', fi.sale_price, 'quantity_limit', fi.quantity_limit, 'sold', fi.sold)) FILTER (WHERE fi.product_id IS NOT NULL), '[]') AS items
     FROM flash_sales fs LEFT JOIN flash_sale_items fi ON fi.flash_sale_id = fs.id LEFT JOIN products p ON p.id = fi.product_id
     GROUP BY fs.id ORDER BY fs.starts_at DESC LIMIT 50`);
  res.json({ success: true, data: r.rows });
}));

router.post(
  '/flash-sales',
  validate(z.object({ body: z.object({
    title: z.string().min(3).max(100), starts_at: z.string().datetime(), ends_at: z.string().datetime(),
    items: z.array(z.object({ product_id: uuid, sale_price: z.number().nonnegative(), quantity_limit: z.number().int().positive().optional().nullable() })).min(1).max(50),
  }) })),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (new Date(b.ends_at) <= new Date(b.starts_at)) throw new AppError(400, 'The sale must end after it starts.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fs = (await client.query(`INSERT INTO flash_sales (title, starts_at, ends_at, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [b.title, b.starts_at, b.ends_at, req.user!.id])).rows[0];
      for (const it of b.items) {
        const p = await client.query(`SELECT price FROM products WHERE id = $1 AND deleted_at IS NULL`, [it.product_id]);
        if (!p.rows[0]) throw new AppError(404, 'One of the products was not found.');
        if (it.sale_price >= Number(p.rows[0].price)) throw new AppError(400, 'A flash-sale price must be lower than the normal price.');
        await client.query(`INSERT INTO flash_sale_items (flash_sale_id, product_id, sale_price, quantity_limit) VALUES ($1,$2,$3,$4)`, [fs.id, it.product_id, it.sale_price, it.quantity_limit ?? null]);
      }
      await client.query('COMMIT');
      await auditFromReq(req, 'flash_sale.create', 'flash_sale', fs.id);
      res.status(201).json({ success: true, data: fs });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }),
);

router.patch('/flash-sales/:id', validate(z.object({ params: idParam.shape.params, body: z.object({ is_active: z.boolean() }) })), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE flash_sales SET is_active = $2 WHERE id = $1`, [req.params.id, req.body.is_active]);
  res.json({ success: true });
}));

// ----- banners -----
const bannerBody = z.object({
  title: z.string().min(2).max(120), subtitle: z.string().max(200).optional().nullable(),
  image_url: z.string().url().optional().nullable(), link_url: z.string().max(300).optional().nullable(),
  placement: z.string().max(40).default('home_hero'), sort_order: z.number().int().default(0),
  starts_at: z.string().datetime().optional().nullable(), ends_at: z.string().datetime().optional().nullable(), is_active: z.boolean().default(true),
});

router.get('/banners', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: (await pool.query(`SELECT * FROM banners ORDER BY placement, sort_order, created_at DESC`)).rows });
}));
router.post('/banners', validate(z.object({ body: bannerBody })), asyncHandler(async (req, res) => {
  const b = req.body as z.infer<typeof bannerBody>;
  const r = await pool.query(
    `INSERT INTO banners (title, subtitle, image_url, link_url, placement, sort_order, starts_at, ends_at, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [b.title, b.subtitle ?? null, b.image_url ?? null, b.link_url ?? null, b.placement, b.sort_order, b.starts_at ?? null, b.ends_at ?? null, b.is_active],
  );
  await auditFromReq(req, 'banner.create', 'banner', r.rows[0].id);
  res.status(201).json({ success: true, data: r.rows[0] });
}));
router.patch('/banners/:id', validate(z.object({ params: idParam.shape.params, body: z.object({ is_active: z.boolean() }) })), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE banners SET is_active = $2 WHERE id = $1`, [req.params.id, req.body.is_active]);
  res.json({ success: true });
}));
router.delete('/banners/:id', validate(idParam), asyncHandler(async (req, res) => {
  await pool.query(`DELETE FROM banners WHERE id = $1`, [req.params.id]);
  await auditFromReq(req, 'banner.delete', 'banner', String(req.params.id));
  res.json({ success: true });
}));

// ----- shipping zones & pickup stations -----
const zoneBody = z.object({
  name: z.string().min(2).max(80),
  counties: z.array(z.string().min(2).max(60)).default([]),
  areas: z.array(z.string().min(2).max(60)).default([]),
  base_fee: z.number().nonnegative(), per_kg_fee: z.number().nonnegative().default(0), free_over: z.number().positive().optional().nullable(),
  est_days_min: z.number().int().min(0).default(2), est_days_max: z.number().int().min(0).default(5), is_active: z.boolean().default(true),
}).refine((z_) => z_.counties.length + z_.areas.length > 0, { message: 'Add at least one county or area', path: ['counties'] });
router.get('/shipping-zones', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: (await pool.query(`SELECT * FROM shipping_zones ORDER BY name`)).rows });
}));
router.post('/shipping-zones', validate(z.object({ body: zoneBody })), asyncHandler(async (req, res) => {
  const z_ = req.body as z.infer<typeof zoneBody>;
  const r = await pool.query(
    `INSERT INTO shipping_zones (name, counties, areas, base_fee, per_kg_fee, free_over, est_days_min, est_days_max, is_active) VALUES ($1,$2,$9,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [z_.name, z_.counties, z_.base_fee, z_.per_kg_fee, z_.free_over ?? null, z_.est_days_min, z_.est_days_max, z_.is_active, z_.areas],
  );
  await auditFromReq(req, 'shipping_zone.create', 'shipping_zone', r.rows[0].id);
  res.status(201).json({ success: true, data: r.rows[0] });
}));
router.put('/shipping-zones/:id', validate(z.object({ params: idParam.shape.params, body: zoneBody })), asyncHandler(async (req, res) => {
  const z_ = req.body as z.infer<typeof zoneBody>;
  await pool.query(
    `UPDATE shipping_zones SET name=$2, counties=$3, areas=$10, base_fee=$4, per_kg_fee=$5, free_over=$6, est_days_min=$7, est_days_max=$8, is_active=$9 WHERE id=$1`,
    [req.params.id, z_.name, z_.counties, z_.base_fee, z_.per_kg_fee, z_.free_over ?? null, z_.est_days_min, z_.est_days_max, z_.is_active, z_.areas],
  );
  await auditFromReq(req, 'shipping_zone.update', 'shipping_zone', String(req.params.id));
  res.json({ success: true });
}));
router.delete('/shipping-zones/:id', validate(idParam), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE shipping_zones SET is_active = false WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
}));

const stationBody = z.object({ name: z.string().min(2).max(100), county: z.string().min(2).max(60), address: z.string().min(3).max(200), phone: z.string().max(20).optional().nullable(), fee: z.number().nonnegative().default(0), is_active: z.boolean().default(true) });
router.get('/pickup-stations', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: (await pool.query(`SELECT * FROM pickup_stations ORDER BY county, name`)).rows });
}));
router.post('/pickup-stations', validate(z.object({ body: stationBody })), asyncHandler(async (req, res) => {
  const b = req.body as z.infer<typeof stationBody>;
  const r = await pool.query(`INSERT INTO pickup_stations (name, county, address, phone, fee, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [b.name, b.county, b.address, b.phone ?? null, b.fee, b.is_active]);
  await auditFromReq(req, 'pickup_station.create', 'pickup_station', r.rows[0].id);
  res.status(201).json({ success: true, data: r.rows[0] });
}));
router.patch('/pickup-stations/:id', validate(z.object({ params: idParam.shape.params, body: z.object({ is_active: z.boolean() }) })), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE pickup_stations SET is_active = $2 WHERE id = $1`, [req.params.id, req.body.is_active]);
  res.json({ success: true });
}));

// ----- CMS pages -----
router.get('/pages', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: (await pool.query(`SELECT slug, title, is_published, updated_at FROM static_pages ORDER BY title`)).rows });
}));
router.get('/pages/:slug', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT * FROM static_pages WHERE slug = $1`, [req.params.slug]);
  if (!r.rows[0]) throw new AppError(404, 'Page not found.');
  res.json({ success: true, data: r.rows[0] });
}));
router.put('/pages/:slug', validate(z.object({ params: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,60}$/) }), body: z.object({ title: z.string().min(2).max(120), body: z.string().min(1).max(60000), is_published: z.boolean().default(true) }) })), asyncHandler(async (req, res) => {
  await pool.query(
    `INSERT INTO static_pages (slug, title, body, is_published, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, is_published = EXCLUDED.is_published, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [req.params.slug, req.body.title, req.body.body, req.body.is_published, req.user!.id],
  );
  await auditFromReq(req, 'page.update', 'page', String(req.params.slug));
  res.json({ success: true });
}));

// ----- staff accounts -----
router.get('/staff', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT id, full_name, email, role, is_active, created_at FROM users WHERE role IN ('moderator','support','finance','admin','super_admin') ORDER BY role, full_name`);
  res.json({ success: true, data: r.rows });
}));

export default router;
