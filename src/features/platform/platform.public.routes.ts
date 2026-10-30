// src/features/platform/platform.public.routes.ts
//
// Storefront content, CMS pages, delivery options, notifications, wallet, customer ↔ vendor
// messaging (moderated) and product Q&A.
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/db';
import { env } from '../../config/env';
import { protect } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import { getWalletBalance } from '../../services/ledger.service';
import { notify } from '../../services/notification.service';

const uuid = z.string().uuid();

// ===========================================================================
// Public content
// ===========================================================================
export const contentRouter = Router();

contentRouter.get('/storefront/home', asyncHandler(async (_req, res) => {
  const [banners, sales] = await Promise.all([
    pool.query(
      `SELECT id, title, subtitle, image_url, link_url FROM banners
       WHERE is_active AND placement = 'home_hero'
         AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at >= NOW())
       ORDER BY sort_order, created_at DESC LIMIT 8`,
    ),
    pool.query(
      `SELECT fs.id, fs.title, fs.ends_at,
              COALESCE(json_agg(json_build_object(
                'product_id', p.id, 'name', p.name, 'slug', p.slug, 'price', p.price, 'sale_price', fi.sale_price,
                'remaining', CASE WHEN fi.quantity_limit IS NULL THEN NULL ELSE GREATEST(0, fi.quantity_limit - fi.sold) END,
                'image', (SELECT url FROM product_images WHERE product_id = p.id ORDER BY is_primary DESC, sort_order LIMIT 1)
              ) ORDER BY fi.sale_price) FILTER (WHERE p.id IS NOT NULL), '[]') AS items
       FROM flash_sales fs
       JOIN flash_sale_items fi ON fi.flash_sale_id = fs.id
       JOIN products p ON p.id = fi.product_id AND p.status = 'active' AND p.is_active AND p.deleted_at IS NULL
       WHERE fs.is_active AND fs.starts_at <= NOW() AND fs.ends_at >= NOW()
       GROUP BY fs.id ORDER BY fs.ends_at LIMIT 3`,
    ),
  ]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, data: { banners: banners.rows, flash_sales: sales.rows } });
}));

contentRouter.get('/pages', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT slug, title FROM static_pages WHERE is_published ORDER BY title`);
  res.json({ success: true, data: r.rows });
}));

contentRouter.get('/pages/:slug', asyncHandler(async (req, res) => {
  const r = await pool.query(`SELECT slug, title, body, updated_at FROM static_pages WHERE slug = $1 AND is_published`, [req.params.slug]);
  if (!r.rows[0]) throw new AppError(404, 'Page not found.');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: r.rows[0] });
}));

contentRouter.get('/shipping/zones', asyncHandler(async (_req, res) => {
  const r = await pool.query(`SELECT id, name, counties, areas, base_fee, per_kg_fee, free_over, est_days_min, est_days_max FROM shipping_zones WHERE is_active ORDER BY name`);
  res.json({ success: true, data: r.rows });
}));

contentRouter.get('/shipping/pickup-stations', asyncHandler(async (req, res) => {
  const county = typeof req.query.county === 'string' ? req.query.county : null;
  const r = await pool.query(
    `SELECT id, name, county, address, phone, fee FROM pickup_stations WHERE is_active AND ($1::text IS NULL OR lower(county) = lower($1)) ORDER BY county, name`,
    [county],
  );
  res.json({ success: true, data: r.rows });
}));

// ===========================================================================
// Product variants (read) + Q&A
// ===========================================================================
export const catalogExtrasRouter = Router();

catalogExtrasRouter.get('/:productId/variants', validate(z.object({ params: z.object({ productId: uuid }) })), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT id, name, sku, options, price, compare_at_price, stock_quantity, image_url, position
     FROM product_variants WHERE product_id = $1 AND is_active ORDER BY position, created_at`,
    [req.params.productId],
  );
  res.json({ success: true, data: r.rows });
}));

catalogExtrasRouter.get('/:productId/questions', validate(z.object({ params: z.object({ productId: uuid }) })), asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT q.id, q.question, q.answer, q.answered_at, q.created_at, split_part(u.full_name, ' ', 1) AS asker
     FROM product_questions q JOIN users u ON u.id = q.user_id
     WHERE q.product_id = $1 ORDER BY q.created_at DESC LIMIT 50`,
    [req.params.productId],
  );
  res.json({ success: true, data: r.rows });
}));

catalogExtrasRouter.post(
  '/:productId/questions',
  protect,
  validate(z.object({ params: z.object({ productId: uuid }), body: z.object({ question: z.string().min(5).max(500) }) })),
  asyncHandler(async (req, res) => {
    assertNoContactDetails(req.body.question);
    const p = await pool.query(`SELECT p.name, s.user_id AS seller_user FROM products p JOIN sellers s ON s.id = p.seller_id WHERE p.id = $1`, [req.params.productId]);
    if (!p.rows[0]) throw new AppError(404, 'Product not found.');
    const q = await pool.query(`INSERT INTO product_questions (product_id, user_id, question) VALUES ($1,$2,$3) RETURNING id`, [req.params.productId, req.user!.id, req.body.question]);
    await notify({ userId: p.rows[0].seller_user, type: 'question', title: `New question about ${p.rows[0].name}`, body: req.body.question, link: '/seller/messages', email: false });
    res.status(201).json({ success: true, data: { id: q.rows[0].id } });
  }),
);

export const questionsRouter = Router();
questionsRouter.post(
  '/:id/answer',
  protect,
  validate(z.object({ params: z.object({ id: uuid }), body: z.object({ answer: z.string().min(2).max(1000) }) })),
  asyncHandler(async (req, res) => {
    assertNoContactDetails(req.body.answer);
    const own = await pool.query(
      `SELECT q.id, q.user_id, p.name FROM product_questions q JOIN products p ON p.id = q.product_id JOIN sellers s ON s.id = p.seller_id
       WHERE q.id = $1 AND (s.user_id = $2 OR $3::boolean)`,
      [req.params.id, req.user!.id, ['admin', 'super_admin', 'support'].includes(req.user!.role)],
    );
    if (!own.rows[0]) throw new AppError(404, 'Question not found for your store.');
    await pool.query(`UPDATE product_questions SET answer = $2, answered_by = $3, answered_at = NOW() WHERE id = $1`, [req.params.id, req.body.answer, req.user!.id]);
    await notify({ userId: own.rows[0].user_id, type: 'question_answered', title: `Your question about ${own.rows[0].name} was answered`, body: req.body.answer, email: false });
    res.json({ success: true });
  }),
);

// ===========================================================================
// Contact-detail guard for messaging / Q&A
// ===========================================================================
const CONTACT_PATTERNS: RegExp[] = [
  /(?:\+?254|\b0)[\s-]?[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/, // Kenyan mobile numbers
  /\b\d{9,}\b/, // long digit runs (numbers split or disguised)
  /[A-Za-z0-9._%+-]+\s?(?:@|\(at\)|\[at\])\s?[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i, // emails
  /https?:\/\/|www\./i, // links
  /\b(?:whats\s?app|telegram|signal|call me|text me|dm me|my number|pay (?:me )?directly|outside (?:loom|the platform))\b/i,
];

export const containsContactDetails = (text: string): boolean => CONTACT_PATTERNS.some((p) => p.test(text));

const assertNoContactDetails = (text: string) => {
  if (containsContactDetails(text)) {
    throw new AppError(
      400,
      'For your safety and payment protection, please keep conversations on Loom — phone numbers, emails, links and requests to pay or chat elsewhere are not allowed.',
    );
  }
};

// ===========================================================================
// Signed-in: notifications, wallet, messaging
// ===========================================================================
export const accountRouter = Router();
// Scoped on purpose: this router is mounted at /api/v1, so an unscoped protect would turn every
// unknown URL into a 401 instead of a 404.
accountRouter.use(['/notifications', '/wallet', '/conversations'], protect);

accountRouter.get('/notifications', asyncHandler(async (req, res) => {
  const [rows, unread] = await Promise.all([
    pool.query(`SELECT id, type, title, body, data, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.user!.id]),
    pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [req.user!.id]),
  ]);
  res.json({ success: true, data: rows.rows, unread: unread.rows[0].n });
}));

accountRouter.post(
  '/notifications/read',
  validate(z.object({ body: z.object({ ids: z.array(uuid).optional() }) })),
  asyncHandler(async (req, res) => {
    await pool.query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
      [req.user!.id, req.body.ids ?? null],
    );
    res.json({ success: true });
  }),
);

accountRouter.get('/wallet', asyncHandler(async (req, res) => {
  const history = await pool.query(
    `SELECT e.created_at, e.direction, e.amount, t.type, COALESCE(t.description, '') AS description
     FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE a.code = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
    [`customer:${req.user!.id}:wallet`],
  );
  res.json({ success: true, data: { balance: await getWalletBalance(req.user!.id), history: history.rows } });
}));

// ----- messaging -----
accountRouter.post(
  '/conversations',
  validate(
    z.object({
      body: z.object({
        store_id: uuid,
        product_id: uuid.optional(),
        order_id: uuid.optional(),
        subject: z.string().max(150).optional(),
        body: z.string().min(1).max(2000),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    assertNoContactDetails(req.body.body);
    const store = await pool.query(`SELECT st.id, st.name, s.user_id AS seller_user FROM stores st JOIN sellers s ON s.id = st.seller_id WHERE st.id = $1`, [req.body.store_id]);
    if (!store.rows[0]) throw new AppError(404, 'Store not found.');
    if (store.rows[0].seller_user === req.user!.id) throw new AppError(400, 'You cannot message your own store.');

    const convo = await pool.query(
      `INSERT INTO conversations (customer_id, store_id, product_id, order_id, subject) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [req.user!.id, req.body.store_id, req.body.product_id ?? null, req.body.order_id ?? null, req.body.subject ?? null],
    );
    await pool.query(`INSERT INTO messages (conversation_id, sender_id, sender_role, body) VALUES ($1,$2,'customer',$3)`, [convo.rows[0].id, req.user!.id, req.body.body]);
    await notify({ userId: store.rows[0].seller_user, type: 'message', title: `New message from a customer`, body: req.body.body.slice(0, 200), link: '/seller/messages', email: false });
    res.status(201).json({ success: true, data: { id: convo.rows[0].id } });
  }),
);

accountRouter.get('/conversations', asyncHandler(async (req, res) => {
  const r = await pool.query(
    `SELECT c.id, c.subject, c.last_message_at, c.order_id, c.product_id, st.name AS store_name, cu.full_name AS customer_name,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.read_at IS NULL AND m.sender_id <> $1) AS unread,
            CASE WHEN c.customer_id = $1 THEN 'customer' ELSE 'seller' END AS viewer_role
     FROM conversations c JOIN stores st ON st.id = c.store_id JOIN sellers s ON s.id = st.seller_id JOIN users cu ON cu.id = c.customer_id
     WHERE c.customer_id = $1 OR s.user_id = $1
     ORDER BY c.last_message_at DESC LIMIT 100`,
    [req.user!.id],
  );
  res.json({ success: true, data: r.rows });
}));

const loadConvo = async (id: string, userId: string) => {
  const c = await pool.query(
    `SELECT c.*, s.user_id AS seller_user, st.name AS store_name FROM conversations c JOIN stores st ON st.id = c.store_id JOIN sellers s ON s.id = st.seller_id WHERE c.id = $1`,
    [id],
  );
  const row = c.rows[0];
  if (!row || (row.customer_id !== userId && row.seller_user !== userId)) throw new AppError(404, 'Conversation not found.');
  return row;
};

accountRouter.get('/conversations/:id/messages', validate(z.object({ params: z.object({ id: uuid }) })), asyncHandler(async (req, res) => {
  const convo = await loadConvo(String(req.params.id), req.user!.id);
  const msgs = await pool.query(`SELECT id, sender_id, sender_role, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [convo.id]);
  await pool.query(`UPDATE messages SET read_at = NOW() WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL`, [convo.id, req.user!.id]);
  res.json({ success: true, data: { conversation: { id: convo.id, subject: convo.subject, store_name: convo.store_name }, messages: msgs.rows, viewer_role: convo.customer_id === req.user!.id ? 'customer' : 'seller' } });
}));

accountRouter.post(
  '/conversations/:id/messages',
  validate(z.object({ params: z.object({ id: uuid }), body: z.object({ body: z.string().min(1).max(2000) }) })),
  asyncHandler(async (req, res) => {
    const convo = await loadConvo(String(req.params.id), req.user!.id);
    assertNoContactDetails(req.body.body);
    const role = convo.customer_id === req.user!.id ? 'customer' : 'seller';
    await pool.query(`INSERT INTO messages (conversation_id, sender_id, sender_role, body) VALUES ($1,$2,$3,$4)`, [convo.id, req.user!.id, role, req.body.body]);
    await pool.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1`, [convo.id]);
    await notify({ userId: role === 'customer' ? convo.seller_user : convo.customer_id, type: 'message', title: `New message from ${role === 'customer' ? 'a customer' : convo.store_name}`, body: req.body.body.slice(0, 200), link: role === 'customer' ? '/seller/messages' : '/account/messages', email: false });
    res.status(201).json({ success: true });
  }),
);


// ===========================================================================
// SEO: sitemap (point robots.txt / Search Console at <API>/api/v1/sitemap.xml)
// ===========================================================================
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

contentRouter.get('/sitemap.xml', asyncHandler(async (_req, res) => {
  const base = env.webUrl;
  const [products, cats, stores, pages] = await Promise.all([
    pool.query(`SELECT slug, updated_at FROM products WHERE status = 'active' AND is_active AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5000`),
    pool.query(`SELECT slug FROM categories WHERE status = 'active' AND depth <= 1`),
    pool.query(`SELECT slug FROM stores WHERE status = 'active' AND deleted_at IS NULL AND slug IS NOT NULL`),
    pool.query(`SELECT slug FROM static_pages WHERE is_published`),
  ]);
  const urls: { loc: string; lastmod?: Date }[] = [
    { loc: `${base}/` }, { loc: `${base}/shop` },
    ...products.rows.map((p) => ({ loc: `${base}/product/${p.slug}`, lastmod: p.updated_at as Date })),
    ...cats.rows.map((c) => ({ loc: `${base}/shop?category=${c.slug}` })),
    ...stores.rows.map((s) => ({ loc: `${base}/store/${s.slug}` })),
    ...pages.rows.map((p) => ({ loc: `${base}/pages/${p.slug}` })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.toISOString()}</lastmod>` : ''}</url>`)
    .join('\n')}\n</urlset>`;
  res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  res.send(xml);
}));
