import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';

// Safaricom and Redis are faked: these tests are about OUR handling of Safaricom's answers.
const post = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { post, get: vi.fn() }, __esModule: true }));
vi.mock('../src/config/redis', () => ({
  redisService: { cacheGet: async () => 'test-token', cacheSet: async () => undefined, ping: async () => true },
}));

import { pool } from '../src/config/db';
import { createOrdersFromCart } from '../src/features/orders/checkout.service';
import { expireUnpaidOrders } from '../src/features/orders/order-lifecycle.service';
import { getPaymentGroupStatus, handleCallback, reconcilePaymentGroup, reconcileStalePayments } from '../src/features/mpesaservice/mpesa.service';
import { getStoreBalances } from '../src/services/ledger.service';
import { createStore, createUser } from './helpers';

afterAll(async () => {
  await pool.end();
});

const address = {
  first_name: 'A', last_name: 'B', email: 'a@test.local', phone: '254712345678',
  address_line1: 'x', city: 'Lodwar', state: 'Turkana', postal_code: '00100', country: 'KE',
};

let n = 0;
/** An order whose STK push was sent (payment_status 'initiated', tx pending) but never confirmed. */
const awaitingPayment = async () => {
  const store = await createStore();
  const customer = await createUser('customer');
  const prod = await pool.query<{ id: string }>(
    `INSERT INTO products (store_id, seller_id, name, slug, price, stock_quantity, status, is_active, is_approved)
     VALUES ($1,$2,$3,$4,1000,10,'active',true,true) RETURNING id`,
    [store.storeId, store.sellerId, `MP${++n}`, `mp-${Date.now()}-${n}`],
  );
  const cart = await pool.query<{ id: string }>(`INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW() RETURNING id`, [customer]);
  await pool.query(`INSERT INTO cart_items (cart_id, product_id, quantity, unit_price) VALUES ($1,$2,2,1000)`, [cart.rows[0].id, prod.rows[0].id]);
  const { orders, payment_group_id } = await createOrdersFromCart(customer, { shipping_address: address } as any);

  const checkoutId = `ws_CO_${randomUUID()}`;
  await pool.query(`UPDATE orders SET payment_status = 'initiated', status = 'payment_pending' WHERE id = $1`, [orders[0].id]);
  const tx = await pool.query<{ id: string }>(
    `INSERT INTO mpesa_transactions (order_id, phone, amount, status, checkout_request_id, initiated_at)
     VALUES ($1,'254712345678',$2,'pending',$3, NOW() - INTERVAL '2 minutes') RETURNING id`,
    [orders[0].id, orders[0].total, checkoutId],
  );
  return { store, orderId: orders[0].id, groupId: payment_group_id, productId: prod.rows[0].id, checkoutId, txId: tx.rows[0].id };
};

const order = async (id: string) => (await pool.query('SELECT status, payment_status, escrow_status, payment FROM orders WHERE id = $1', [id])).rows[0];
const txRow = async (id: string) => (await pool.query('SELECT status, result_code, mpesa_receipt FROM mpesa_transactions WHERE id = $1', [id])).rows[0];
const stock = async (id: string) => (await pool.query('SELECT stock_quantity FROM products WHERE id = $1', [id])).rows[0].stock_quantity as number;

beforeEach(() => { post.mockClear(); post.mockImplementation(async () => ({ data: {} })); });

describe('confirming a payment without the callback (STK Push Query)', () => {
  it('Safaricom says paid → order is PAID and the money is held in escrow', async () => {
    const p = await awaitingPayment();
    post.mockResolvedValue({ data: { ResultCode: '0', ResultDesc: 'The service request is processed successfully.' } });

    expect(await reconcilePaymentGroup(p.groupId)).toBe('success');

    expect(await order(p.orderId)).toMatchObject({ status: 'paid', payment_status: 'paid', escrow_status: 'held' });
    expect(await txRow(p.txId)).toMatchObject({ status: 'success', result_code: '0' });
    // 2 × 1000 items + KSh 300 delivery = 2300; 10% commission (200); delivery is Loom's → vendor owed 1800
    expect((await getStoreBalances(p.store.storeId)).pending).toBe(1800);
    // it asked Safaricom's query endpoint for THIS checkout request
    expect(post.mock.calls[0][0]).toContain('/mpesa/stkpushquery/v1/query');
    expect(post.mock.calls[0][1].CheckoutRequestID).toBe(p.checkoutId);
  });

  it('the status endpoint the web page polls does this automatically — the page stops spinning', async () => {
    const p = await awaitingPayment();
    post.mockResolvedValue({ data: { ResultCode: '0', ResultDesc: 'ok' } });
    const status = await getPaymentGroupStatus(p.groupId);
    expect(status.status).toBe('success');
    expect(status.orders_paid).toBe(1);
  });

  it('customer cancelled on the phone (1032) → failed, stock returned', async () => {
    const p = await awaitingPayment();
    expect(await stock(p.productId)).toBe(8);
    post.mockResolvedValue({ data: { ResultCode: '1032', ResultDesc: 'Request cancelled by user' } });

    expect(await reconcilePaymentGroup(p.groupId)).toBe('failed');
    expect(await txRow(p.txId)).toMatchObject({ status: 'cancelled', result_code: '1032' });
    expect((await order(p.orderId)).status).toBe('failed');
    expect(await stock(p.productId)).toBe(10);
  });

  it('wrong PIN / insufficient funds → failed with the reason', async () => {
    const p = await awaitingPayment();
    post.mockResolvedValue({ data: { ResultCode: '1', ResultDesc: 'The balance is insufficient for the transaction.' } });
    expect(await reconcilePaymentGroup(p.groupId)).toBe('failed');
    expect((await pool.query('SELECT result_desc FROM mpesa_transactions WHERE id = $1', [p.txId])).rows[0].result_desc).toMatch(/insufficient/i);
  });

  it('still being processed → stays pending (customer is still entering the PIN)', async () => {
    const p = await awaitingPayment();
    post.mockImplementation(async () => { throw { response: { data: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } } }; });
    expect(await reconcilePaymentGroup(p.groupId)).toBe('pending');
    expect((await txRow(p.txId)).status).toBe('pending');
    expect((await order(p.orderId)).payment_status).toBe('initiated');
  });

  it('a network failure never fails a payment', async () => {
    const p = await awaitingPayment();
    post.mockImplementation(async () => { throw new Error('getaddrinfo ENOTFOUND sandbox.safaricom.co.ke'); });
    expect(await reconcilePaymentGroup(p.groupId)).toBe('pending');
    expect((await txRow(p.txId)).status).toBe('pending');
    expect(await stock(p.productId)).toBe(8); // untouched
  });

  it('is throttled: polling every few seconds does not hammer Safaricom', async () => {
    const p = await awaitingPayment();
    post.mockImplementation(async () => { throw { response: { data: { errorMessage: 'The transaction is being processed' } } }; });
    await reconcilePaymentGroup(p.groupId);
    await reconcilePaymentGroup(p.groupId);
    await reconcilePaymentGroup(p.groupId);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('background sweep settles payments whose customer closed the page', async () => {
    const p = await awaitingPayment();
    post.mockResolvedValue({ data: { ResultCode: '0', ResultDesc: 'ok' } });
    expect(await reconcileStalePayments()).toBeGreaterThanOrEqual(1);
    expect((await order(p.orderId)).payment_status).toBe('paid');
  });
});

describe('callback and query never double-process', () => {
  const callback = (checkoutId: string, receipt: string) => ({
    Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: checkoutId, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: receipt }] } } },
  });

  it('callback arrives AFTER the query confirmed it: receipt is attached, money is not credited twice', async () => {
    const p = await awaitingPayment();
    post.mockResolvedValue({ data: { ResultCode: '0', ResultDesc: 'ok' } });
    await reconcilePaymentGroup(p.groupId);
    expect((await txRow(p.txId)).mpesa_receipt).toBeNull();

    await handleCallback(callback(p.checkoutId, 'SKB1234567') as any);

    expect((await txRow(p.txId)).mpesa_receipt).toBe('SKB1234567');
    expect((await order(p.orderId)).payment.mpesa_receipt).toBe('SKB1234567');
    expect((await getStoreBalances(p.store.storeId)).pending).toBe(1800); // still once
  });

  it('callback arrives FIRST: the later query finds nothing left to settle', async () => {
    const p = await awaitingPayment();
    await handleCallback(callback(p.checkoutId, 'SKB7654321') as any);
    expect((await order(p.orderId)).payment_status).toBe('paid');

    post.mockResolvedValue({ data: { ResultCode: '0', ResultDesc: 'ok' } });
    expect(await reconcilePaymentGroup(p.groupId)).toBe('pending'); // nothing pending → no-op
    expect(post).not.toHaveBeenCalled();
    expect((await getStoreBalances(p.store.storeId)).pending).toBe(1800);
  });
});

describe('abandoned M-Pesa checkouts', () => {
  it("an order stuck at payment_status 'initiated' now expires and returns its stock", async () => {
    const p = await awaitingPayment();
    await pool.query(`UPDATE orders SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [p.orderId]);
    await expireUnpaidOrders();
    expect((await order(p.orderId)).status).toBe('cancelled');
    expect(await stock(p.productId)).toBe(10);
  });
});
