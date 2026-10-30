// src/config/seed.ts
//
//   npm run seed
//
// Builds a demo marketplace in a LOCAL database: staff, vendors, customers, categories, products
// (with variants), promotions, and orders in every state (paid, shipped, delivered, disputed…).
// It goes through the real services, so it doubles as an end-to-end exercise of checkout, escrow
// and disputes. It refuses to run against any non-local database.
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { env } from './env';
import { pool } from './db';
import { createOrdersFromCart } from '../features/orders/checkout.service';
import { confirmDelivery, markDelivered, markPaymentGroupPaid, shipOrder } from '../features/orders/order-lifecycle.service';
import { openDispute } from '../features/aftersales/aftersales.service';
import { createReturn } from '../features/aftersales/aftersales.service';

const PASSWORD = 'Loom@12345';

const assertLocal = () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url) || env.IS_PRODUCTION) {
    console.error('✖ Refusing to seed: DATABASE_URL is not a local database.');
    process.exit(1);
  }
};

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const makeUser = async (email: string, name: string, role: string, phone?: string) => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, phone, phone_verified)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`,
    [email, hash, name, role, phone ?? null],
  );
  return r.rows[0].id;
};

const makeVendor = async (email: string, owner: string, storeName: string, phone: string) => {
  const userId = await makeUser(email, owner, 'seller', phone);
  const slug = slugify(storeName);
  const seller = await pool.query<{ id: string }>(
    `INSERT INTO sellers (user_id, business_name, trading_name, tax_id, registration_number, country, state, city, business_address, store_name,
                          business_phone, status, verification_status, verified_at, payout_method, mpesa_phone, payout_schedule)
     VALUES ($1,$2,$2,$3,$4,'KE','Nairobi','Nairobi','Moi Avenue 1',$2,$5,'active','verified',NOW(),'mpesa',$5,'weekly')
     ON CONFLICT (user_id) DO UPDATE SET status = 'active' RETURNING id`,
    [userId, storeName, `P${slug.slice(0, 8).toUpperCase()}`, `REG-${slug}`, phone],
  );
  const store = await pool.query<{ id: string }>(
    `INSERT INTO stores (seller_id, name, slug, status, is_active, approved_at, description)
     VALUES ($1,$2,$3,'active',true,NOW(),$4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [seller.rows[0].id, storeName, slug, `${storeName} — trusted seller on Loom.`],
  );
  const storeId = store.rows[0]?.id ?? (await pool.query(`SELECT id FROM stores WHERE slug = $1`, [slug])).rows[0].id;
  return { userId, sellerId: seller.rows[0].id, storeId };
};

const CATEGORIES: [string, string[]][] = [
  ['Electronics', ['Phones', 'Laptops', 'Audio']],
  ['Fashion', ['Women', 'Men', 'Shoes']],
  ['Home', ['Kitchen', 'Furniture']],
  ['Beauty', ['Skincare']],
];

const seedCategories = async () => {
  const ids: Record<string, string> = {};
  let order = 0;
  for (const [dept, kids] of CATEGORIES) {
    const dslug = slugify(dept);
    const d = await pool.query<{ id: string }>(
      `INSERT INTO categories (name, slug, path, type, depth, is_leaf, status, is_featured, sort_order)
       VALUES ($1,$2,$3::ltree,'department',0,false,'active',true,$4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [dept, dslug, dslug, ++order],
    );
    const parent = d.rows[0]?.id ?? (await pool.query(`SELECT id FROM categories WHERE slug = $1`, [dslug])).rows[0].id;
    ids[dept] = parent;
    for (const k of kids) {
      const kslug = slugify(`${dept}-${k}`).replace(/-/g, '_');
      const c = await pool.query<{ id: string }>(
        `INSERT INTO categories (name, slug, parent_id, path, type, depth, is_leaf, status, sort_order)
         VALUES ($1,$2,$3,($4 || '.' || $5)::ltree,'leaf',1,true,'active',1)
         ON CONFLICT DO NOTHING RETURNING id`,
        [k, slugify(`${dept}-${k}`), parent, dslug, kslug],
      );
      ids[k] = c.rows[0]?.id ?? (await pool.query(`SELECT id FROM categories WHERE slug = $1`, [slugify(`${dept}-${k}`)])).rows[0].id;
    }
  }
  return ids;
};

interface P { name: string; price: number; was?: number; stock: number; cat: string; desc: string; featured?: boolean; weight?: number }
const PRODUCTS: Record<'tech' | 'style', P[]> = {
  tech: [
    { name: 'Samsung Galaxy A15 128GB', price: 18500, was: 21999, stock: 25, cat: 'Phones', desc: '6.5" display, 128GB storage, 50MP camera.', featured: true, weight: 0.3 },
    { name: 'Tecno Spark 20 Pro', price: 15200, was: 17500, stock: 30, cat: 'Phones', desc: 'Fast charging, 8GB RAM, great battery life.', weight: 0.3 },
    { name: 'HP 250 G9 Laptop i5 8GB 512GB SSD', price: 56000, was: 64000, stock: 8, cat: 'Laptops', desc: '15.6" full HD, Intel Core i5, Windows 11.', featured: true, weight: 1.8 },
    { name: 'JBL Tune 510BT Wireless Headphones', price: 5200, was: 6500, stock: 40, cat: 'Audio', desc: '40-hour battery, pure bass sound.', weight: 0.2 },
    { name: 'Sony WH-1000XM4 Noise Cancelling', price: 29900, stock: 6, cat: 'Audio', desc: 'Industry-leading noise cancellation.', featured: true, weight: 0.3 },
    { name: 'Phone charger 25W fast USB-C', price: 1200, stock: 0, cat: 'Phones', desc: 'Out-of-stock demo product.', weight: 0.1 },
  ],
  style: [
    { name: 'Ankara Print Maxi Dress', price: 3800, was: 4500, stock: 20, cat: 'Women', desc: 'Handmade Ankara fabric, available in several sizes.', featured: true, weight: 0.6 },
    { name: 'Men’s Slim Fit Chinos', price: 2400, stock: 35, cat: 'Men', desc: 'Stretch cotton, tailored fit.', weight: 0.5 },
    { name: 'Leather Sandals (Maasai style)', price: 2900, was: 3400, stock: 18, cat: 'Shoes', desc: 'Hand-stitched leather soles.', weight: 0.7 },
    { name: 'Non-stick Cookware Set 7pc', price: 6800, was: 8200, stock: 12, cat: 'Kitchen', desc: 'Even heating, easy to clean.', featured: true, weight: 4 },
    { name: 'Shea Butter Face Cream 100ml', price: 950, stock: 60, cat: 'Skincare', desc: 'Natural moisturiser for all skin types.', weight: 0.15 },
    { name: 'Wooden Coffee Table', price: 11500, was: 13500, stock: 5, cat: 'Furniture', desc: 'Solid mahogany, 90×50cm.', weight: 14 },
  ],
};

const seedProducts = async (store: { storeId: string; sellerId: string }, list: P[], cats: Record<string, string>, tag: string) => {
  const out: { id: string; name: string; price: number }[] = [];
  for (const p of list) {
    const slug = `${slugify(p.name)}-${tag}`;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO products (store_id, seller_id, name, slug, description, short_description, category_id, price, compare_at_price, stock_quantity,
                             stock_status, status, is_active, is_approved, is_featured, weight, published_at, condition)
       VALUES ($1,$2,$3,$4,$5::text,$5::text,$6,$7,$8,$9,$10,'active',true,true,$11,$12,NOW(),'new')
       ON CONFLICT (store_id, slug) DO UPDATE SET price = EXCLUDED.price RETURNING id`,
      [store.storeId, store.sellerId, p.name, slug, p.desc, cats[p.cat], p.price, p.was ?? null, p.stock, p.stock > 0 ? 'in_stock' : 'out_of_stock', !!p.featured, p.weight ?? 0.5],
    );
    const id = r.rows[0].id;
    const has = await pool.query(`SELECT 1 FROM product_images WHERE product_id = $1`, [id]);
    if (!has.rows.length) {
      await pool.query(
        `INSERT INTO product_images (product_id, url, public_id, is_primary, sort_order) VALUES ($1,$2,$3,true,0)`,
        [id, `https://picsum.photos/seed/${slugify(p.name)}/800/800`, `seed/${slug}`],
      );
    }
    out.push({ id, name: p.name, price: p.price });
  }
  return out;
};

const addVariants = async (productId: string, base: number, variants: [string, number][]) => {
  const exists = await pool.query(`SELECT 1 FROM product_variants WHERE product_id = $1`, [productId]);
  if (exists.rows.length) return;
  let pos = 0;
  for (const [name, stock] of variants) {
    await pool.query(
      `INSERT INTO product_variants (product_id, name, options, price, stock_quantity, position) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
      [productId, name, JSON.stringify({ Option: name }), base, stock, pos++],
    );
  }
  await pool.query(`UPDATE products SET has_variants = true, stock_quantity = (SELECT SUM(stock_quantity) FROM product_variants WHERE product_id = $1) WHERE id = $1`, [productId]);
};

const address = (state = 'Nairobi', city = 'Westlands') => ({
  first_name: 'Amina', last_name: 'Otieno', email: 'amina@loom.test', phone: '254712345678', address_line1: 'Waiyaki Way 12', city, state, postal_code: '00100', country: 'KE',
});

const buy = async (customerId: string, items: { productId: string; qty: number; price: number }[], opts: { coupon?: string; state?: string } = {}) => {
  const cart = await pool.query<{ id: string }>(`INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW() RETURNING id`, [customerId]);
  await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cart.rows[0].id]);
  for (const it of items) {
    await pool.query(`INSERT INTO cart_items (cart_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)`, [cart.rows[0].id, it.productId, it.qty, it.price]);
  }
  return createOrdersFromCart(customerId, { shipping_address: address(opts.state), coupon_code: opts.coupon } as any);
};

const pay = (groupId: string) => markPaymentGroupPaid(groupId, `SEED${randomUUID().slice(0, 6).toUpperCase()}`, randomUUID());

const main = async () => {
  assertLocal();
  console.log('🌱 Seeding demo marketplace…');

  // ---- people
  const superAdmin = await makeUser('admin@loom.test', 'Loom Admin', 'super_admin', '0700000001');
  await makeUser('finance@loom.test', 'Fiona Finance', 'finance', '0700000002');
  await makeUser('support@loom.test', 'Sam Support', 'support', '0700000003');
  await makeUser('moderator@loom.test', 'Mo Moderator', 'moderator', '0700000004');
  const tech = await makeVendor('techhub@loom.test', 'Tom Techhub', 'TechHub Kenya', '0711111111');
  const style = await makeVendor('style@loom.test', 'Sela Style', 'Savannah Style & Home', '0722222222');
  const amina = await makeUser('amina@loom.test', 'Amina Otieno', 'customer', '254712345678');
  const brian = await makeUser('brian@loom.test', 'Brian Kamau', 'customer', '254723456789');
  await makeUser('carol@loom.test', 'Carol Wanjiru', 'customer', '254734567890');

  // ---- catalogue
  const cats = await seedCategories();
  const techProducts = await seedProducts(tech, PRODUCTS.tech, cats, 'th');
  const styleProducts = await seedProducts(style, PRODUCTS.style, cats, 'ss');
  await addVariants(styleProducts[0].id, 3800, [['Size S', 6], ['Size M', 8], ['Size L', 6]]);
  await addVariants(styleProducts[2].id, 2900, [['EU 40', 5], ['EU 42', 7], ['EU 44', 6]]);

  // ---- promotions, delivery, content
  await pool.query(`INSERT INTO coupons (code, description, type, value, min_subtotal, scope, created_by) VALUES ('WELCOME10','10% off your first order','percent',10,1000,'platform',$1) ON CONFLICT DO NOTHING`, [superAdmin]);
  await pool.query(`INSERT INTO coupons (code, description, type, value, scope, store_id, created_by) VALUES ('TECH500','KSh 500 off at TechHub','fixed',500,'store',$1,$2) ON CONFLICT DO NOTHING`, [tech.storeId, tech.userId]);
  const sale = await pool.query<{ id: string }>(
    `INSERT INTO flash_sales (title, starts_at, ends_at, created_by) SELECT 'Weekend tech deals', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '3 days', $1
     WHERE NOT EXISTS (SELECT 1 FROM flash_sales) RETURNING id`, [superAdmin]);
  if (sale.rows[0]) {
    await pool.query(`INSERT INTO flash_sale_items (flash_sale_id, product_id, sale_price, quantity_limit) VALUES ($1,$2,15900,10),($1,$3,4400,15)`, [sale.rows[0].id, techProducts[0].id, techProducts[3].id]);
  }
  await pool.query(`INSERT INTO banners (title, subtitle, link_url) SELECT 'Back to work', 'Laptops and accessories for less', '/shop?category=electronics' WHERE NOT EXISTS (SELECT 1 FROM banners)`);
  await pool.query(`INSERT INTO pickup_stations (name, county, address, phone, fee) SELECT * FROM (VALUES ('Loom Pickup — CBD','Nairobi','Kenyatta Ave, next to Archives','0700111222',100), ('Loom Pickup — Nyali','Mombasa','Nyali Centre, ground floor','0700333444',150)) v(a,b,c,d,e) WHERE NOT EXISTS (SELECT 1 FROM pickup_stations)`);

  // ---- orders in every state (skipped if the demo orders already exist)
  const existing = await pool.query(`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ANY($1)`, [[amina, brian]]);
  if (existing.rows[0].n === 0) {
    const seller = (v: typeof tech) => ({ id: v.userId, role: 'seller' });

    // 1) Paid, waiting to be shipped (multi-vendor cart → 2 orders)
    const o1 = await buy(amina, [{ productId: techProducts[3].id, qty: 1, price: 5200 }, { productId: styleProducts[1].id, qty: 2, price: 2400 }]);
    await pay(o1.payment_group_id);

    // 2) Shipped
    const o2 = await buy(amina, [{ productId: techProducts[1].id, qty: 1, price: 15200 }], { coupon: 'WELCOME10' });
    await pay(o2.payment_group_id);
    await shipOrder(o2.orders[0].id, seller(tech), { carrier: 'Sendy', tracking_number: 'SND-100245' });

    // 3) Delivered, awaiting customer confirmation (escrow still held)
    const o3 = await buy(brian, [{ productId: styleProducts[3].id, qty: 1, price: 6800 }], { state: 'Mombasa' });
    await pay(o3.payment_group_id);
    await shipOrder(o3.orders[0].id, seller(style), { carrier: 'G4S', tracking_number: 'G4S-77881' });
    await markDelivered(o3.orders[0].id, seller(style));

    // 4) Completed — customer confirmed; funds released to the vendor's available balance
    const o4 = await buy(brian, [{ productId: techProducts[2].id, qty: 1, price: 56000 }]);
    await pay(o4.payment_group_id);
    await shipOrder(o4.orders[0].id, seller(tech), { carrier: 'Sendy', tracking_number: 'SND-100300' });
    await markDelivered(o4.orders[0].id, seller(tech));
    await confirmDelivery(o4.orders[0].id, brian);

    // 5) Delivered + an open dispute (escrow locked)
    const o5 = await buy(amina, [{ productId: techProducts[4].id, qty: 1, price: 29900 }]);
    await pay(o5.payment_group_id);
    await shipOrder(o5.orders[0].id, seller(tech), { carrier: 'Sendy', tracking_number: 'SND-100310' });
    await markDelivered(o5.orders[0].id, seller(tech));
    await openDispute({ id: amina, role: 'customer' }, { order_id: o5.orders[0].id, reason: 'Item is not as described', description: 'The headphones have a scratch and the box was opened.' });

    // 6) Completed order with a return in progress
    const o6 = await buy(brian, [{ productId: styleProducts[4].id, qty: 1, price: 950 }]);
    await pay(o6.payment_group_id);
    await shipOrder(o6.orders[0].id, seller(style), { carrier: 'G4S', tracking_number: 'G4S-77900' });
    await markDelivered(o6.orders[0].id, seller(style));
    await confirmDelivery(o6.orders[0].id, brian);
    const line = await pool.query(`SELECT id FROM order_items WHERE order_id = $1`, [o6.orders[0].id]);
    await createReturn(brian, { order_id: o6.orders[0].id, order_item_id: line.rows[0].id, reason: 'Wrong item received', description: 'I ordered the 200ml tub.' });

    // 7) Unpaid, abandoned checkout (will expire)
    await buy(amina, [{ productId: techProducts[0].id, qty: 1, price: 18500 }]);
  }

  console.log('\n✅ Done. Demo logins (all use the password below, local database only):\n');
  console.log(`   password: ${PASSWORD}`);
  console.log('   super admin  admin@loom.test      → /admin/dashboard');
  console.log('   finance      finance@loom.test    → /admin/dashboard');
  console.log('   support      support@loom.test    → /admin/dashboard');
  console.log('   moderator    moderator@loom.test  → /moderator/dashboard');
  console.log('   seller       techhub@loom.test    → /dashboard');
  console.log('   seller       style@loom.test      → /dashboard');
  console.log('   customer     amina@loom.test      → /account/orders');
  console.log('   customer     brian@loom.test');
  console.log('\n   coupons: WELCOME10 (platform, 10%), TECH500 (TechHub, KSh 500 off)\n');
  await pool.end();
};

main().catch(async (err) => {
  console.error('✖ Seed failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
