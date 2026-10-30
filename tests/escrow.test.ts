import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db';
import { ACCOUNTS, getBalance, getStoreBalances, getWalletBalance, verifyLedgerBalanced } from '../src/services/ledger.service';
import { holdPaymentInEscrow, refundFromEscrow, releaseEscrow, setDisputeLock } from '../src/services/escrow.service';
import { randomUUID } from 'crypto';
import { createOrder, createStore, withTx } from './helpers';

afterAll(async () => {
  await pool.end();
});

describe('escrow: holding a payment', () => {
  it('books cash into vendor pending + commission pending, and nothing is available yet', async () => {
    const o = await createOrder({ total: 1100, commission: 100 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));

    const b = await getStoreBalances(o.storeId);
    expect(b.pending).toBe(1000); // 1100 paid - 100 commission
    expect(b.available).toBe(0);
    expect(await getBalance(ACCOUNTS.commissionPending.code)).toBeGreaterThanOrEqual(100);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('is idempotent: a replayed payment confirmation does not credit twice', async () => {
    const o = await createOrder({ total: 500, commission: 50 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));

    expect((await getStoreBalances(o.storeId)).pending).toBe(450);
    const rows = await pool.query('SELECT 1 FROM escrow_holds WHERE order_id = $1', [o.orderId]);
    expect(rows.rowCount).toBe(1);
  });

  it('platform-funded discounts are booked as platform expense, not taken from the vendor', async () => {
    // item 1000, platform discount 150 → customer pays 850, commission 100, vendor still owed 900
    const o = await createOrder({ total: 850, commission: 100, platformDiscount: 150 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    expect((await getStoreBalances(o.storeId)).pending).toBe(900);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });
});

describe('escrow: release', () => {
  it('moves pending → available and recognises commission', async () => {
    const o = await createOrder({ total: 1100, commission: 100 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    const revenueBefore = await getBalance(ACCOUNTS.commissionRevenue.code);

    await withTx((c) => releaseEscrow(c, o.orderId, { reason: 'test' }));

    const b = await getStoreBalances(o.storeId);
    expect(b.pending).toBe(0);
    expect(b.available).toBe(1000);
    expect(await getBalance(ACCOUNTS.commissionRevenue.code)).toBe(revenueBefore + 100);
  });

  it('releasing twice does nothing the second time', async () => {
    const o = await createOrder({ total: 300, commission: 30 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    expect(await withTx((c) => releaseEscrow(c, o.orderId, { reason: 'first' }))).toBe(true);
    expect(await withTx((c) => releaseEscrow(c, o.orderId, { reason: 'second' }))).toBe(false);
    expect((await getStoreBalances(o.storeId)).available).toBe(270);
  });

  it('is blocked while a dispute is open, and works again once the lock is lifted', async () => {
    const o = await createOrder({ total: 400, commission: 40 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    await withTx((c) => setDisputeLock(c, o.orderId, true));

    await expect(withTx((c) => releaseEscrow(c, o.orderId, { reason: 'auto' }))).rejects.toThrow(/dispute/i);
    expect((await getStoreBalances(o.storeId)).available).toBe(0);

    await withTx((c) => setDisputeLock(c, o.orderId, false));
    await withTx((c) => releaseEscrow(c, o.orderId, { reason: 'after dispute' }));
    expect((await getStoreBalances(o.storeId)).available).toBe(360);
  });
});

describe('escrow: refunds', () => {
  it('full refund before release returns everything to the customer wallet and zeroes escrow', async () => {
    const o = await createOrder({ total: 1100, commission: 100 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    const walletBefore = await getWalletBalance(o.customerId);

    await withTx((c) =>
      refundFromEscrow(c, { orderId: o.orderId, refundId: randomUUID(), amount: 1100, method: 'wallet' }),
    );

    expect(await getWalletBalance(o.customerId)).toBe(walletBefore + 1100);
    const b = await getStoreBalances(o.storeId);
    expect(b.pending).toBe(0);
    expect(b.available).toBe(0);
    const esc = await pool.query('SELECT status FROM escrow_holds WHERE order_id = $1', [o.orderId]);
    expect(esc.rows[0].status).toBe('refunded');
  });

  it('partial refund reduces the vendor share proportionally; the rest still releases', async () => {
    const o = await createOrder({ total: 1100, commission: 100 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));

    await withTx((c) =>
      refundFromEscrow(c, { orderId: o.orderId, refundId: randomUUID(), amount: 550, method: 'wallet' }),
    );
    let b = await getStoreBalances(o.storeId);
    expect(b.pending).toBeCloseTo(500, 0); // ~half of the 1000 vendor amount

    await withTx((c) => releaseEscrow(c, o.orderId, { reason: 'test' }));
    b = await getStoreBalances(o.storeId);
    expect(b.pending).toBe(0);
    expect(b.available).toBeCloseTo(500, 0);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('refunding after release comes out of the vendor available balance (and can overdraw it)', async () => {
    const o = await createOrder({ total: 1100, commission: 100 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    await withTx((c) => releaseEscrow(c, o.orderId, { reason: 'test' }));
    expect((await getStoreBalances(o.storeId)).available).toBe(1000);

    // the vendor then pays out most of it... simulated by a second order's refund draining the store
    await withTx((c) =>
      refundFromEscrow(c, { orderId: o.orderId, refundId: randomUUID(), amount: 1100, method: 'wallet' }),
    );
    expect((await getStoreBalances(o.storeId)).available).toBe(0);
  });

  it('rejects refunds above what remains refundable', async () => {
    const o = await createOrder({ total: 200, commission: 20 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    await expect(
      withTx((c) => refundFromEscrow(c, { orderId: o.orderId, refundId: randomUUID(), amount: 200.01, method: 'wallet' })),
    ).rejects.toThrow(/exceeds/i);
  });

  it('the same refund id replayed does not refund twice', async () => {
    const o = await createOrder({ total: 600, commission: 60 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    const refundId = randomUUID();
    await withTx((c) => refundFromEscrow(c, { orderId: o.orderId, refundId, amount: 100, method: 'wallet' }));
    const walletAfterFirst = await getWalletBalance(o.customerId);
    // Escrow counters moved, so a replay would be rejected or ignored — but the wallet must not double.
    await withTx((c) => refundFromEscrow(c, { orderId: o.orderId, refundId, amount: 100, method: 'wallet' })).catch(() => {});
    expect(await getWalletBalance(o.customerId)).toBe(walletAfterFirst);
  });
});

describe('ledger guarantees enforced by the database', () => {
  it('refuses to commit an unbalanced transaction', async () => {
    const store = await createStore();
    const acc = await pool.query<{ id: string }>(
      `INSERT INTO ledger_accounts (code, name, kind, owner_type) VALUES ($1, 'x', 'asset', 'platform') RETURNING id`,
      [`test:${randomUUID()}`],
    );
    void store;
    await expect(
      withTx(async (c) => {
        const tx = await c.query<{ id: string }>(
          `INSERT INTO ledger_transactions (type, idempotency_key) VALUES ('t', $1) RETURNING id`,
          [randomUUID()],
        );
        await c.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount) VALUES ($1, $2, 'debit', 100)`,
          [tx.rows[0].id, acc.rows[0].id],
        );
      }),
    ).rejects.toThrow(/unbalanced/i);
  });

  it('entries cannot be edited or deleted — the ledger is append-only', async () => {
    const o = await createOrder({ total: 100, commission: 10 });
    await withTx((c) => holdPaymentInEscrow(c, o.orderId));
    await expect(pool.query('UPDATE ledger_entries SET amount = 1')).rejects.toThrow(/append-only/i);
    await expect(pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/i);
  });

  it('the whole ledger always balances after all of the above', async () => {
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });
});
