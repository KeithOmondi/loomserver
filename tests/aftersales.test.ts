import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../src/config/db';
import { createOrdersFromCart } from '../src/features/orders/checkout.service';
import { confirmDelivery, markDelivered, markPaymentGroupPaid, shipOrder } from '../src/features/orders/order-lifecycle.service';
import * as svc from '../src/features/aftersales/aftersales.service';
import { releaseDueEscrows } from '../src/services/escrow.service';
import { getStoreBalances, getWalletBalance, verifyLedgerBalanced } from '../src/services/ledger.service';
import { createStore, createUser } from './helpers';

afterAll(async () => {
  await pool.end();
});

const address = {
  first_name: 'A', last_name: 'B', email: 'a@test.local', phone: '254712345678',
  address_line1: 'x', city: 'Lodwar', state: 'Turkana', postal_code: '00100', country: 'KE',
};

let n = 0;
/** A delivered, paid order: 1000 item + 300 delivery; 10% commission (100); delivery (300) is Loom's → vendor owed 900. */
const deliveredOrder = async (opts: { confirm?: boolean } = {}) => {
  const store = await createStore();
  const customer = await createUser('customer');
  const prod = await pool.query<{ id: string }>(
    `INSERT INTO products (store_id, seller_id, name, slug, price, stock_quantity, status, is_active, is_approved)
     VALUES ($1,$2,$3,$4,1000,10,'active',true,true) RETURNING id`,
    [store.storeId, store.sellerId, `P${++n}`, `p-${Date.now()}-${n}`],
  );
  const cart = await pool.query<{ id: string }>(`INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW() RETURNING id`, [customer]);
  await pool.query(`INSERT INTO cart_items (cart_id, product_id, quantity, unit_price) VALUES ($1,$2,1,1000)`, [cart.rows[0].id, prod.rows[0].id]);
  const { orders, payment_group_id } = await createOrdersFromCart(customer, { shipping_address: address } as any);
  await markPaymentGroupPaid(payment_group_id, `R${randomUUID().slice(0, 6)}`, randomUUID());
  const seller = { id: store.userId, role: 'seller' };
  await shipOrder(orders[0].id, seller, { carrier: 'X', tracking_number: `T${n}` });
  await markDelivered(orders[0].id, seller);
  if (opts.confirm) await confirmDelivery(orders[0].id, customer);
  const itemId = (await pool.query('SELECT id FROM order_items WHERE order_id = $1', [orders[0].id])).rows[0].id;
  return { store, customer, orderId: orders[0].id, itemId, seller };
};

const support = async () => ({ id: await createUser('support'), role: 'support' });
const finance = async () => ({ id: await createUser('finance'), role: 'finance' });

describe('disputes lock the money', () => {
  it('opening a dispute freezes release even after the auto-confirm window', async () => {
    const o = await deliveredOrder();
    await svc.openDispute({ id: o.customer, role: 'customer' }, { order_id: o.orderId, reason: 'Item not as described' });
    await pool.query(`UPDATE escrow_holds SET release_after = NOW() - INTERVAL '1 minute' WHERE order_id = $1`, [o.orderId]);
    await releaseDueEscrows();
    expect((await getStoreBalances(o.store.storeId)).available).toBe(0);
    await expect(confirmDelivery(o.orderId, o.customer)).rejects.toThrow(/dispute/i);
  });

  it('only one open dispute per order, and strangers cannot open one', async () => {
    const o = await deliveredOrder();
    await svc.openDispute({ id: o.customer, role: 'customer' }, { order_id: o.orderId, reason: 'Broken' });
    await expect(svc.openDispute({ id: o.customer, role: 'customer' }, { order_id: o.orderId, reason: 'Again' })).rejects.toThrow();
    await expect(svc.openDispute({ id: await createUser('customer'), role: 'customer' }, { order_id: o.orderId, reason: 'Hack' })).rejects.toThrow(/own orders/i);
  });

  it('the turn passes between parties, and a missed deadline escalates to support', async () => {
    const o = await deliveredOrder();
    const d = await svc.openDispute({ id: o.customer, role: 'customer' }, { order_id: o.orderId, reason: 'Late' });
    expect(d.status).toBe('awaiting_vendor');

    await svc.addDisputeMessage(d.id, o.seller, 'We shipped on time, see tracking.');
    expect((await svc.getDispute(d.id, { id: o.customer, role: 'customer' })).status).toBe('awaiting_customer');

    await pool.query(`UPDATE disputes SET respond_by = NOW() - INTERVAL '1 minute' WHERE id = $1`, [d.id]);
    expect(await svc.escalateOverdueDisputes()).toBeGreaterThanOrEqual(1);
    expect((await svc.getDispute(d.id, { id: o.customer, role: 'customer' })).status).toBe('under_review');
  });

  it('full refund: customer gets everything in their wallet, vendor gets nothing', async () => {
    const o = await deliveredOrder();
    const d = await svc.openDispute({ id: o.customer, role: 'customer' }, { order_id: o.orderId, reason: 'Never arrived' });
    await svc.resolveDispute(d.id, await support(), { resolution: 'full_refund', notes: 'Courier lost it' });

    expect(await getWalletBalance(o.customer)).toBe(1300);
    const b = await getStoreBalances(o.store.storeId);
    expect(b.pending + b.available).toBe(0);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('release to vendor: vendor is paid and the lock is lifted', async () => {
    const o = await deliveredOrder();
    const d = await svc.openDispute({ id: o.customer, role: 'customer' }, { order_id: o.orderId, reason: 'Changed mind' });
    await svc.resolveDispute(d.id, await support(), { resolution: 'release_to_vendor', notes: 'Item was as described' });
    expect((await getStoreBalances(o.store.storeId)).available).toBe(900);
  });

  it('partial refund: customer gets part, vendor keeps the rest', async () => {
    const o = await deliveredOrder();
    const d = await svc.openDispute({ id: o.customer, role: 'customer' }, { order_id: o.orderId, reason: 'Scratched' });
    await svc.resolveDispute(d.id, await support(), { resolution: 'partial_refund', amount: 500, notes: 'Cosmetic damage' });

    expect(await getWalletBalance(o.customer)).toBe(500);
    const b = await getStoreBalances(o.store.storeId);
    expect(b.pending).toBe(0);
    // the vendor keeps their share of the remaining 800 of the 1300 paid (items + delivery)
    expect(b.available).toBeGreaterThan(500);
    expect(b.available).toBeLessThan(900);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('only support/admin can resolve; an invalid partial amount is refused', async () => {
    const o = await deliveredOrder();
    const d = await svc.openDispute({ id: o.customer, role: 'customer' }, { order_id: o.orderId, reason: 'x1' });
    await expect(svc.resolveDispute(d.id, { id: o.customer, role: 'customer' }, { resolution: 'full_refund', notes: 'give me money' })).rejects.toThrow(/support/i);
    await expect(svc.resolveDispute(d.id, await support(), { resolution: 'partial_refund', amount: 99999, notes: 'too much' })).rejects.toThrow(/partial refund/i);
  });
});

describe('returns → refunds', () => {
  it('approved return → received → finance approves → customer refunded, vendor debited', async () => {
    const o = await deliveredOrder({ confirm: true }); // already released to vendor
    expect((await getStoreBalances(o.store.storeId)).available).toBe(900);

    const ret = await svc.createReturn(o.customer, { order_id: o.orderId, order_item_id: o.itemId, reason: 'Wrong size', preferred_resolution: 'wallet' });
    await svc.decideReturn(ret.id, o.seller, true);
    const refund = await svc.markReturnReceived(ret.id, o.seller);
    expect(Number(refund.amount)).toBe(1000);

    await svc.approveRefund(refund.id, await finance(), {});
    expect(await getWalletBalance(o.customer)).toBe(1000);
    // refund after release comes out of the vendor's available balance
    expect((await getStoreBalances(o.store.storeId)).available).toBeLessThan(900);
    expect((await pool.query('SELECT status FROM returns WHERE id = $1', [ret.id])).rows[0].status).toBe('refunded');
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('refund to original payment method requires the M-Pesa reference; the same refund cannot be approved twice', async () => {
    const o = await deliveredOrder({ confirm: true });
    const ret = await svc.createReturn(o.customer, { order_id: o.orderId, order_item_id: o.itemId, reason: 'Faulty' });
    await svc.decideReturn(ret.id, o.seller, true);
    const refund = await svc.markReturnReceived(ret.id, o.seller, 400); // partial
    const fin = await finance();
    await expect(svc.approveRefund(refund.id, fin, {})).rejects.toThrow(/reference/i);
    await svc.approveRefund(refund.id, fin, { reference: 'QWE123RTY' });
    await expect(svc.approveRefund(refund.id, fin, { reference: 'QWE123RTY' })).rejects.toThrow(/already/i);
  });

  it('enforces the return window and one open return per item', async () => {
    const o = await deliveredOrder({ confirm: true });
    await svc.createReturn(o.customer, { order_id: o.orderId, order_item_id: o.itemId, reason: 'First' });
    await expect(svc.createReturn(o.customer, { order_id: o.orderId, order_item_id: o.itemId, reason: 'Again' })).rejects.toThrow(/already in progress/i);

    const late = await deliveredOrder({ confirm: true });
    await pool.query(`UPDATE orders SET delivered_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [late.orderId]);
    await expect(svc.createReturn(late.customer, { order_id: late.orderId, order_item_id: late.itemId, reason: 'Too late' })).rejects.toThrow(/window/i);
  });

  it("a seller cannot decide another store's return", async () => {
    const o = await deliveredOrder({ confirm: true });
    const ret = await svc.createReturn(o.customer, { order_id: o.orderId, order_item_id: o.itemId, reason: 'Nope' });
    const other = await createStore();
    await expect(svc.decideReturn(ret.id, { id: other.userId, role: 'seller' }, true)).rejects.toThrow(/your store/i);
  });

  it('a rejected return can be escalated into a dispute, which locks the funds', async () => {
    const o = await deliveredOrder(); // not yet released
    const ret = await svc.createReturn(o.customer, { order_id: o.orderId, order_item_id: o.itemId, reason: 'Defective' });
    await svc.decideReturn(ret.id, o.seller, false, 'Customer damaged it');
    const dispute = await svc.escalateReturn(ret.id, o.customer);
    expect(dispute.return_id).toBe(ret.id);
    const esc = (await pool.query('SELECT dispute_locked FROM escrow_holds WHERE order_id = $1', [o.orderId])).rows[0];
    expect(esc.dispute_locked).toBe(true);
  });
});
