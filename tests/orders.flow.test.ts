import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../src/config/db';
import { createOrdersFromCart, quoteCheckout } from '../src/features/orders/checkout.service';
import {
  cancelOrderWithRefund,
  confirmDelivery,
  expireUnpaidOrders,
  markDelivered,
  markPaymentGroupFailed,
  markPaymentGroupPaid,
  shipOrder,
} from '../src/features/orders/order-lifecycle.service';
import { releaseDueEscrows } from '../src/services/escrow.service';
import { ACCOUNTS, getBalance, getStoreBalances, getWalletBalance, verifyLedgerBalanced } from '../src/services/ledger.service';
import { setSetting } from '../src/services/settings.service';
import { createStore, createUser } from './helpers';

afterAll(async () => {
  await pool.end();
});

const address = {
  first_name: 'Amina', last_name: 'Otieno', email: 'a@test.local', phone: '254712345678',
  address_line1: 'Moi Ave', city: 'Lodwar', state: 'Turkana', postal_code: '00100', country: 'KE',
};

let n = 0;
const makeProduct = async (store: { storeId: string; sellerId: string }, price: number, stock: number, extra = '') => {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO products (store_id, seller_id, name, slug, price, stock_quantity, status, is_active, is_approved ${extra ? ',' + extra.split('=')[0] : ''})
     VALUES ($1, $2, $3, $4, $5, $6, 'active', true, true ${extra ? ',' + extra.split('=')[1] : ''}) RETURNING id`,
    [store.storeId, store.sellerId, `Product ${++n}`, `prod-${Date.now()}-${n}`, price, stock],
  );
  return res.rows[0].id;
};

const fillCart = async (userId: string, items: { productId: string; qty: number; variantId?: string; price: number }[]) => {
  const cart = await pool.query<{ id: string }>(`INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW() RETURNING id`, [userId]);
  for (const it of items) {
    await pool.query(
      `INSERT INTO cart_items (cart_id, product_id, variant_id, quantity, unit_price) VALUES ($1,$2,$3,$4,$5)`,
      [cart.rows[0].id, it.productId, it.variantId ?? null, it.qty, it.price],
    );
  }
};

const stock = async (productId: string) =>
  (await pool.query('SELECT stock_quantity FROM products WHERE id = $1', [productId])).rows[0].stock_quantity as number;

const payGroup = (groupId: string) => markPaymentGroupPaid(groupId, `RCP${randomUUID().slice(0, 8)}`, randomUUID());

describe('checkout', () => {
  it('prices from LIVE data, ignoring a stale/tampered cart snapshot, and adds delivery + commission', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 1000, 10);
    await fillCart(customer, [{ productId: p, qty: 2, price: 1 /* stale snapshot */ }]);

    const { orders, total } = await createOrdersFromCart(customer, { shipping_address: address } as any);
    expect(orders).toHaveLength(1);
    // 2 × 1000 = 2000 items + KSh 300 default delivery
    expect(orders[0].subtotal).toBe(2000);
    expect(orders[0].shipping_total).toBe(300);
    expect(total).toBe(2300);
    // default 10% commission on items only
    const row = (await pool.query('SELECT commission_total, expires_at FROM orders WHERE id = $1', [orders[0].id])).rows[0];
    expect(Number(row.commission_total)).toBe(200);
    expect(row.expires_at).not.toBeNull();
    expect(await stock(p)).toBe(8); // reserved
  });

  it('splits a multi-vendor cart into one order per vendor under one payment group', async () => {
    const a = await createStore();
    const b = await createStore();
    const customer = await createUser('customer');
    const pa = await makeProduct(a, 500, 5);
    const pb = await makeProduct(b, 700, 5);
    await fillCart(customer, [{ productId: pa, qty: 1, price: 500 }, { productId: pb, qty: 1, price: 700 }]);

    const res = await createOrdersFromCart(customer, { shipping_address: address } as any);
    expect(res.orders).toHaveLength(2);
    expect(new Set(res.orders.map((o) => o.store_id)).size).toBe(2);
    const groups = await pool.query('SELECT DISTINCT payment_group_id FROM orders WHERE id = ANY($1)', [res.orders.map((o) => o.id)]);
    expect(groups.rowCount).toBe(1);
  });

  it('refuses to oversell: only one of two concurrent buyers gets the last unit', async () => {
    const store = await createStore();
    const p = await makeProduct(store, 100, 1);
    const [c1, c2] = [await createUser('customer'), await createUser('customer')];
    await fillCart(c1, [{ productId: p, qty: 1, price: 100 }]);
    await fillCart(c2, [{ productId: p, qty: 1, price: 100 }]);

    const results = await Promise.allSettled([
      createOrdersFromCart(c1, { shipping_address: address } as any),
      createOrdersFromCart(c2, { shipping_address: address } as any),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await stock(p)).toBe(0);
  });

  it('quote matches what checkout then charges', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 800, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 800 }]);
    const quote = await quoteCheckout(customer, { shipping_address: address } as any);
    const { total } = await createOrdersFromCart(customer, { shipping_address: address } as any);
    expect(quote.total).toBe(total);
  });
});

describe('delivery pricing', () => {
  const quoteFor = async (state: string, city: string, price = 1000) => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, price, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price }]);
    return quoteCheckout(customer, { shipping_address: { ...address, state, city } } as any);
  };

  it('prices Nairobi by neighbourhood: Westlands, Kasarani and Rongai all differ', async () => {
    expect((await quoteFor('Nairobi', 'Westlands')).shipping).toBe(150); // Zone A
    expect((await quoteFor('Nairobi', 'Kileleshwa')).shipping).toBe(250); // Zone B
    expect((await quoteFor('Nairobi', 'Kasarani')).shipping).toBe(350); // Zone C
    expect((await quoteFor('Nairobi', 'Rongai')).shipping).toBe(500); // Zone D
  });

  it('area matching ignores case and spacing, and works even when the county is another one', async () => {
    expect((await quoteFor('Kajiado', '  rongai ')).shipping).toBe(500); // Rongai is in Kajiado county
    expect((await quoteFor('Nairobi', 'WESTLANDS')).shipping).toBe(150);
  });

  it('an unlisted Nairobi neighbourhood falls back to the county zone', async () => {
    expect((await quoteFor('Nairobi', 'Muthaiga')).shipping).toBe(250); // "Nairobi metro"
  });

  it('uses the zone for the destination county (Nairobi metro: KSh 250 base)', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 1000, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 1000 }]);
    const q = await quoteCheckout(customer, { shipping_address: { ...address, state: 'Nairobi' } } as any);
    expect(q.shipping).toBe(250);
    expect(q.orders[0].est_days).toEqual({ min: 1, max: 2 });
  });

  it('is free once the order reaches the zone free-delivery threshold', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 5000, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 5000 }]);
    const q = await quoteCheckout(customer, { shipping_address: { ...address, state: 'Nairobi' } } as any);
    expect(q.shipping).toBe(0);
  });

  it('falls back to the default fee for a county outside every zone', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 1000, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 1000 }]);
    expect((await quoteCheckout(customer, { shipping_address: address } as any)).shipping).toBe(300);
  });
});

describe('who keeps the delivery fee', () => {
  const checkoutAndPay = async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 1000, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 1000 }]);
    const { orders, payment_group_id } = await createOrdersFromCart(customer, { shipping_address: address } as any);
    const before = await getBalance(ACCOUNTS.deliveryPending.code);
    await payGroup(payment_group_id);
    return { store, orders, deliveryHeld: (await getBalance(ACCOUNTS.deliveryPending.code)) - before };
  };

  it('couriers (default): Loom holds the delivery fee in escrow, the vendor earns items − commission', async () => {
    const { store, orders, deliveryHeld } = await checkoutAndPay();
    expect(deliveryHeld).toBe(300);
    expect((await getStoreBalances(store.storeId)).pending).toBe(900);
    const row = (await pool.query('SELECT platform_delivery_fee, shipping_total FROM orders WHERE id = $1', [orders[0].id])).rows[0];
    expect(Number(row.platform_delivery_fee)).toBe(Number(row.shipping_total));
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('delivery fee becomes Loom revenue only when escrow releases', async () => {
    const { store, orders } = await checkoutAndPay();
    const revBefore = await getBalance(ACCOUNTS.deliveryRevenue.code);
    await shipOrder(orders[0].id, { id: store.userId, role: 'seller' }, { carrier: 'Sendy', tracking_number: 'DLV-1' });
    await markDelivered(orders[0].id, { id: store.userId, role: 'seller' });
    expect(await getBalance(ACCOUNTS.deliveryRevenue.code)).toBe(revBefore);
    await pool.query('UPDATE escrow_holds SET release_after = NOW() - INTERVAL \'1 minute\' WHERE order_id = $1', [orders[0].id]);
    await releaseDueEscrows();
    expect(await getBalance(ACCOUNTS.deliveryRevenue.code)).toBe(revBefore + 300);
  });

  it('cancelling a paid order returns the delivery fee to the customer too', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 1000, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 1000 }]);
    const { orders, payment_group_id } = await createOrdersFromCart(customer, { shipping_address: address } as any);
    await payGroup(payment_group_id);
    const pendingBefore = await getBalance(ACCOUNTS.deliveryPending.code);
    await cancelOrderWithRefund(orders[0].id, { id: customer, role: 'customer' }, 'changed my mind');
    expect(await getWalletBalance(customer)).toBe(1300);
    expect(await getBalance(ACCOUNTS.deliveryPending.code)).toBe(pendingBefore - 300);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('setting delivery.handled_by = vendor: the vendor keeps the delivery fee instead', async () => {
    const admin = await createUser('admin');
    await setSetting('delivery.handled_by', 'vendor', admin);
    try {
      const { store, deliveryHeld } = await checkoutAndPay();
      expect(deliveryHeld).toBe(0);
      expect((await getStoreBalances(store.storeId)).pending).toBe(1200); // 1000 + 300 delivery − 100 commission
    } finally {
      await setSetting('delivery.handled_by', 'platform', admin);
    }
  });
});

describe('coupons', () => {
  it('a vendor coupon reduces the price AND the vendor payout, not the platform fee base', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 1000, 5);
    await pool.query(
      `INSERT INTO coupons (code, type, value, scope, store_id) VALUES ('VENDOR10', 'percent', 10, 'store', $1)`,
      [store.storeId],
    );
    await fillCart(customer, [{ productId: p, qty: 1, price: 1000 }]);
    const { orders } = await createOrdersFromCart(customer, { shipping_address: address, coupon_code: 'vendor10' } as any);
    const row = (await pool.query('SELECT total, vendor_discount, commission_total FROM orders WHERE id = $1', [orders[0].id])).rows[0];
    expect(Number(row.vendor_discount)).toBe(100);
    expect(Number(row.total)).toBe(1200); // 1000 - 100 + 300 delivery
    expect(Number(row.commission_total)).toBe(90); // 10% of 900
  });

  it('enforces the per-user limit and releases it when the order is cancelled', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 1000, 5);
    await pool.query(`INSERT INTO coupons (code, type, value, scope) VALUES ('ONCE50', 'fixed', 50, 'platform')`);

    await fillCart(customer, [{ productId: p, qty: 1, price: 1000 }]);
    const first = await createOrdersFromCart(customer, { shipping_address: address, coupon_code: 'ONCE50' } as any);

    await fillCart(customer, [{ productId: p, qty: 1, price: 1000 }]);
    await expect(
      createOrdersFromCart(customer, { shipping_address: address, coupon_code: 'ONCE50' } as any),
    ).rejects.toThrow(/already used/i);

    await cancelOrderWithRefund(first.orders[0].id, { id: customer, role: 'customer' }, 'changed mind');
    // freed: the coupon works again
    const again = await createOrdersFromCart(customer, { shipping_address: address, coupon_code: 'ONCE50' } as any);
    expect(again.orders).toHaveLength(1);
  });

  it('rejects an invalid code', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 100, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 100 }]);
    await expect(createOrdersFromCart(customer, { shipping_address: address, coupon_code: 'NOPE' } as any)).rejects.toThrow(/invalid/i);
  });
});

describe('payment → escrow → delivery → release', () => {
  const setup = async (price = 1000, qty = 1) => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, price, 10);
    await fillCart(customer, [{ productId: p, qty, price }]);
    const res = await createOrdersFromCart(customer, { shipping_address: address } as any);
    return { store, customer, product: p, order: res.orders[0], groupId: res.payment_group_id };
  };

  it('payment moves the order to PAID and holds the money in escrow', async () => {
    const { store, order, groupId } = await setup();
    await payGroup(groupId);
    const o = (await pool.query('SELECT status, payment_status, escrow_status FROM orders WHERE id = $1', [order.id])).rows[0];
    expect(o).toEqual({ status: 'paid', payment_status: 'paid', escrow_status: 'held' });
    // 1000 items + 300 delivery; 10% commission (100); delivery (300) is Loom's, to pay couriers
    // → the vendor is owed 900 in escrow, nothing available
    const b = await getStoreBalances(store.storeId);
    expect(b.pending).toBe(900);
    expect(b.available).toBe(0);
  });

  it('a replayed payment callback does not credit twice', async () => {
    const { store, groupId } = await setup();
    await payGroup(groupId);
    await payGroup(groupId);
    expect((await getStoreBalances(store.storeId)).pending).toBe(900);
  });

  it('full happy path: ship → deliver → customer confirms → vendor gets paid', async () => {
    const { store, customer, order, groupId } = await setup();
    await payGroup(groupId);
    const sellerActor = { id: store.userId, role: 'seller' };

    await shipOrder(order.id, sellerActor, { carrier: 'Sendy', tracking_number: 'TRK123' });
    expect((await pool.query('SELECT status, tracking_number FROM orders WHERE id = $1', [order.id])).rows[0]).toMatchObject({ status: 'shipped', tracking_number: 'TRK123' });

    await markDelivered(order.id, sellerActor);
    expect((await getStoreBalances(store.storeId)).available).toBe(0); // still held until confirm / window

    await confirmDelivery(order.id, customer);
    const b = await getStoreBalances(store.storeId);
    expect(b.pending).toBe(0);
    expect(b.available).toBe(900);
    expect((await pool.query('SELECT status, escrow_status FROM orders WHERE id = $1', [order.id])).rows[0]).toEqual({ status: 'completed', escrow_status: 'released' });
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('auto-confirm: escrow releases after the window with no dispute, and not before', async () => {
    const { store, order, groupId } = await setup();
    await payGroup(groupId);
    await shipOrder(order.id, { id: store.userId, role: 'seller' }, { carrier: 'X', tracking_number: 'T-AUTO' });
    await markDelivered(order.id, { id: store.userId, role: 'seller' });

    await releaseDueEscrows();
    expect((await getStoreBalances(store.storeId)).available).toBe(0); // window not elapsed

    await pool.query(`UPDATE escrow_holds SET release_after = NOW() - INTERVAL '1 minute' WHERE order_id = $1`, [order.id]);
    await releaseDueEscrows();
    expect((await getStoreBalances(store.storeId)).available).toBe(900);
  });

  it('a dispute lock stops auto-release', async () => {
    const { store, order, groupId } = await setup();
    await payGroup(groupId);
    await shipOrder(order.id, { id: store.userId, role: 'seller' }, { carrier: 'X', tracking_number: 'T-LOCK' });
    await markDelivered(order.id, { id: store.userId, role: 'seller' });
    await pool.query(`UPDATE escrow_holds SET release_after = NOW() - INTERVAL '1 minute', dispute_locked = true WHERE order_id = $1`, [order.id]);
    await releaseDueEscrows();
    expect((await getStoreBalances(store.storeId)).available).toBe(0);
  });

  it("only the order's own seller may ship it, and the buyer cannot confirm someone else's order", async () => {
    const { order, groupId, customer } = await setup();
    await payGroup(groupId);
    const stranger = await createStore();
    await expect(shipOrder(order.id, { id: stranger.userId, role: 'seller' }, { carrier: 'X', tracking_number: 'T-BAD' })).rejects.toThrow(/does not belong/i);
    await expect(confirmDelivery(order.id, await createUser('customer'))).rejects.toThrow();
    void customer;
  });

  it('cannot ship an unpaid order', async () => {
    const { store, order } = await setup();
    await expect(shipOrder(order.id, { id: store.userId, role: 'seller' }, { carrier: 'X', tracking_number: 'T-UNPAID' })).rejects.toThrow(/not paid/i);
  });
});

describe('failure, expiry and cancellation', () => {
  it('a failed payment restores stock', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 100, 5);
    await fillCart(customer, [{ productId: p, qty: 3, price: 100 }]);
    const { payment_group_id } = await createOrdersFromCart(customer, { shipping_address: address } as any);
    expect(await stock(p)).toBe(2);

    await markPaymentGroupFailed(payment_group_id, 'cancelled by user');
    await markPaymentGroupFailed(payment_group_id, 'replay'); // must not restore twice
    expect(await stock(p)).toBe(5);
  });

  it('unpaid orders expire and return their stock', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 100, 5);
    await fillCart(customer, [{ productId: p, qty: 2, price: 100 }]);
    const { orders } = await createOrdersFromCart(customer, { shipping_address: address } as any);
    await pool.query(`UPDATE orders SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [orders[0].id]);

    await expireUnpaidOrders();
    expect(await stock(p)).toBe(5);
    expect((await pool.query('SELECT status FROM orders WHERE id = $1', [orders[0].id])).rows[0].status).toBe('cancelled');
  });

  it('cancelling a PAID order before shipping refunds the customer to their wallet and frees stock', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 1000, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 1000 }]);
    const { orders, payment_group_id } = await createOrdersFromCart(customer, { shipping_address: address } as any);
    await payGroup(payment_group_id);

    await cancelOrderWithRefund(orders[0].id, { id: customer, role: 'customer' }, 'ordered by mistake');

    expect(await getWalletBalance(customer)).toBe(1300); // item + delivery
    const b = await getStoreBalances(store.storeId);
    expect(b.pending).toBe(0);
    expect(b.available).toBe(0);
    expect(await stock(p)).toBe(5);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('cannot cancel once shipped', async () => {
    const store = await createStore();
    const customer = await createUser('customer');
    const p = await makeProduct(store, 100, 5);
    await fillCart(customer, [{ productId: p, qty: 1, price: 100 }]);
    const { orders, payment_group_id } = await createOrdersFromCart(customer, { shipping_address: address } as any);
    await payGroup(payment_group_id);
    await shipOrder(orders[0].id, { id: store.userId, role: 'seller' }, { carrier: 'X', tracking_number: 'T-SHIP' });
    await expect(cancelOrderWithRefund(orders[0].id, { id: customer, role: 'customer' })).rejects.toThrow(/already shipped/i);
  });
});
