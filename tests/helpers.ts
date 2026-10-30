import { randomUUID } from 'crypto';
import { pool } from '../src/config/db';

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${++counter}`;

export const createUser = async (role = 'customer'): Promise<string> => {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, 'x', $2, $3) RETURNING id`,
    [`u${uniq()}@test.local`, `Test ${role}`, role],
  );
  return res.rows[0].id;
};

export const createStore = async (): Promise<{ storeId: string; sellerId: string; userId: string }> => {
  const userId = await createUser('seller');
  const s = await pool.query<{ id: string }>(
    `INSERT INTO sellers (user_id, business_name, tax_id, registration_number, country, state, city,
                          business_address, store_name, trading_name, business_phone)
     VALUES ($1, $2, $3, $4, 'KE', 'Nairobi', 'Nairobi', 'addr', $5, $6, '0700000000')
     RETURNING id`,
    [userId, `Biz ${uniq()}`, `TAX-${uniq()}`, `REG-${uniq()}`, `Store ${uniq()}`, `Trading ${uniq()}`],
  );
  const st = await pool.query<{ id: string }>(
    `INSERT INTO stores (seller_id, name, slug) VALUES ($1, 'Store', $2) RETURNING id`,
    [s.rows[0].id, `store-${uniq()}`],
  );
  return { storeId: st.rows[0].id, sellerId: s.rows[0].id, userId };
};

export interface TestOrder {
  orderId: string;
  storeId: string;
  sellerId: string;
  customerId: string;
}

/** Inserts a paid-pending order with explicit money fields (the checkout normally computes these). */
export const createOrder = async (opts: {
  total: number;
  commission: number;
  platformDiscount?: number;
  /** delivery fee held by the platform for couriers (part of `total`) */
  platformDelivery?: number;
  store?: { storeId: string; sellerId: string };
  customerId?: string;
}): Promise<TestOrder> => {
  const store = opts.store ?? (await createStore());
  const customerId = opts.customerId ?? (await createUser('customer'));
  const res = await pool.query<{ id: string }>(
    `INSERT INTO orders (order_number, store_id, user_id, seller_id, customer, shipping, payment,
                         subtotal, total, commission_total, platform_discount, platform_delivery_fee, payment_status, status)
     VALUES ($1, $2, $3, $4, '{}', '{}', '{}', $5, $5, $6, $7, $8, 'paid', 'paid')
     RETURNING id`,
    [`ORD-T-${uniq()}-${randomUUID().slice(0, 4)}`, store.storeId, customerId, store.sellerId, opts.total, opts.commission, opts.platformDiscount ?? 0, opts.platformDelivery ?? 0],
  );
  return { orderId: res.rows[0].id, storeId: store.storeId, sellerId: store.sellerId, customerId };
};

export const withTx = async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
