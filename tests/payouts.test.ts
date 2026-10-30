import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/config/db';
import * as svc from '../src/features/payouts/payouts.service';
import { holdPaymentInEscrow, releaseEscrow } from '../src/services/escrow.service';
import { ACCOUNTS, getBalance, getStoreBalances, verifyLedgerBalanced } from '../src/services/ledger.service';
import { createOrder, createStore, createUser, withTx } from './helpers';

afterAll(async () => {
  await pool.end();
});

const finance = async () => ({ id: await createUser('finance'), role: 'finance' });

/** A store whose vendor has `net` KES available (released from escrow) and mpesa payout details. */
const storeWithAvailable = async (total: number, commission: number, withDetails = true) => {
  const store = await createStore();
  if (withDetails) {
    await pool.query(`UPDATE sellers SET payout_method = 'mpesa', mpesa_phone = '0712345678', payout_schedule = 'weekly' WHERE id = $1`, [store.sellerId]);
  }
  const o = await createOrder({ total, commission, store });
  await withTx((c) => holdPaymentInEscrow(c, o.orderId));
  await withTx((c) => releaseEscrow(c, o.orderId, { reason: 'test' }));
  return store;
};

const payoutFor = async (storeId: string) =>
  (await pool.query('SELECT * FROM payouts WHERE store_id = $1 ORDER BY created_at DESC LIMIT 1', [storeId])).rows[0];

describe('payout batches', () => {
  it('reserves the vendor balance immediately, so it cannot be paid twice', async () => {
    const store = await storeWithAvailable(10_000, 1_000); // vendor available 9000
    await svc.generateBatch(null, 'weekly');

    const p = await payoutFor(store.storeId);
    expect(Number(p.amount)).toBe(9000);
    expect(p.status).toBe('pending');
    expect((await getStoreBalances(store.storeId)).available).toBe(0);

    // a second batch finds nothing left for this store
    await svc.generateBatch(null, 'weekly');
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM payouts WHERE store_id = $1', [store.storeId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('skips stores below the minimum, on hold, or without payout details', async () => {
    const small = await storeWithAvailable(300, 30); // 270 < 500 minimum
    const held = await storeWithAvailable(10_000, 1_000);
    const noDetails = await storeWithAvailable(10_000, 1_000, false);
    await svc.placeHold(held.storeId, await finance(), 'Fraud review');

    await svc.generateBatch(null, 'all');
    for (const s of [small, held, noDetails]) {
      expect(await payoutFor(s.storeId)).toBeUndefined();
    }
  });

  it('a released hold makes the store eligible again', async () => {
    const store = await storeWithAvailable(5_000, 500);
    const fin = await finance();
    await svc.placeHold(store.storeId, fin, 'Review');
    await expect(svc.placeHold(store.storeId, fin, 'Again')).rejects.toThrow(/already/i);
    await svc.releaseHold(store.storeId, fin);
    await svc.generateBatch(null, 'all');
    expect(await payoutFor(store.storeId)).toBeDefined();
  });
});

describe('payout lifecycle', () => {
  it('approve → paid: cash leaves the platform and the ledger stays balanced', async () => {
    const store = await storeWithAvailable(10_000, 1_000);
    const fin = await finance();
    const { batch } = await svc.generateBatch(null, 'weekly');
    await svc.approveBatch(batch.id, fin);

    let p = await payoutFor(store.storeId);
    expect(p.status).toBe('processing');

    const clearingBefore = await getBalance(ACCOUNTS.payoutsClearing.code);
    await svc.markPayoutPaid(p.id, fin, 'QJK1234567');
    p = await payoutFor(store.storeId);
    expect(p.status).toBe('paid');
    expect(p.reference).toBe('QJK1234567');
    expect(await getBalance(ACCOUNTS.payoutsClearing.code)).toBe(clearingBefore - 9000);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('a payout cannot be marked paid twice, nor before approval', async () => {
    const store = await storeWithAvailable(10_000, 1_000);
    const fin = await finance();
    const { batch } = await svc.generateBatch(null, 'weekly');
    const p = await payoutFor(store.storeId);
    await expect(svc.markPayoutPaid(p.id, fin, 'EARLY123')).rejects.toThrow(/processing/i);
    await svc.approveBatch(batch.id, fin);
    await svc.markPayoutPaid(p.id, fin, 'REF-ONE-1');
    await expect(svc.markPayoutPaid(p.id, fin, 'REF-TWO-2')).rejects.toThrow(/processing/i);
  });

  it('failed payout returns the money to the vendor; retry reserves it again', async () => {
    const store = await storeWithAvailable(10_000, 1_000);
    const fin = await finance();
    const { batch } = await svc.generateBatch(null, 'weekly');
    await svc.approveBatch(batch.id, fin);
    const p = await payoutFor(store.storeId);

    await svc.markPayoutFailed(p.id, fin, 'Invalid M-Pesa number');
    expect((await payoutFor(store.storeId)).status).toBe('failed');
    expect((await getStoreBalances(store.storeId)).available).toBe(9000);

    await svc.retryPayout(p.id, fin);
    expect((await payoutFor(store.storeId)).status).toBe('processing');
    expect((await getStoreBalances(store.storeId)).available).toBe(0);
    expect((await verifyLedgerBalanced()).balanced).toBe(true);
  });

  it('cancelling a draft batch returns every reservation', async () => {
    const store = await storeWithAvailable(10_000, 1_000);
    const fin = await finance();
    const { batch } = await svc.generateBatch(null, 'weekly');
    await svc.cancelBatch(batch.id, fin);
    expect((await getStoreBalances(store.storeId)).available).toBe(9000);
    await expect(svc.approveBatch(batch.id, fin)).rejects.toThrow(/already/i);
  });

  it('the vendor statement CSV lists their ledger movements and neutralises formula injection', async () => {
    const store = await storeWithAvailable(2_000, 200);
    const csv = await svc.buildStatementCsv(store.userId, new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
    expect(csv.split('\n')[0]).toContain('Amount (KES)');
    expect(csv.split('\n').length).toBeGreaterThan(2);
    expect(svc.toCsv(['x'], [['=HYPERLINK("evil")']])).toContain("'=HYPERLINK");
    expect(svc.toCsv(['x'], [['-12.50']])).toContain('-12.50'); // real negative numbers untouched
  });
});
