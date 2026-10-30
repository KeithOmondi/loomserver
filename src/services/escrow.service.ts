// src/services/escrow.service.ts
//
// Escrow lifecycle for a paid order. Customer money is held (vendor share + commission) until the
// customer confirms delivery or the auto-confirm window passes, and never while a dispute is open.
//
//   paid ──► held ──► released            (delivery confirmed / auto-confirm, no dispute)
//             └────► partially_refunded ─► released | refunded
//
// The money itself lives in the ledger; escrow_holds only records the state and the remainders.
import type { PoolClient } from 'pg';
import { pool } from '../config/db';
import { AppError } from '../utils/response';
import { ACCOUNTS, postTransaction } from './ledger.service';
import { refundParts, round2, toCents } from './money';
import { getNumberSetting } from './settings.service';

interface EscrowRow {
  id: string;
  order_id: string;
  store_id: string;
  vendor_amount: string;
  commission_amount: string;
  delivery_amount: string;
  promo_amount: string;
  status: 'held' | 'released' | 'refunded' | 'partially_refunded';
  refunded_vendor: string;
  refunded_commission: string;
  refunded_delivery: string;
  refunded_promo: string;
  dispute_locked: boolean;
}

const lockEscrow = async (client: PoolClient, orderId: string): Promise<EscrowRow> => {
  const res = await client.query<EscrowRow>('SELECT * FROM escrow_holds WHERE order_id = $1 FOR UPDATE', [orderId]);
  if (res.rows.length === 0) throw new AppError(404, 'No escrow found for this order.');
  return res.rows[0];
};

/**
 * Called when payment for an order is confirmed. Books the cash into escrow:
 *   Dr M-Pesa clearing (+ promo expense)  /  Cr vendor pending + commission pending
 * Safe to call twice (idempotent per order).
 */
export const holdPaymentInEscrow = async (client: PoolClient, orderId: string): Promise<void> => {
  const res = await client.query(
    `SELECT id, store_id, seller_id, total, commission_total, platform_discount, platform_delivery_fee
     FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  const order = res.rows[0];
  if (!order) throw new AppError(404, 'Order not found.');

  const total = Number(order.total);
  const commission = Number(order.commission_total);
  const promo = Number(order.platform_discount);
  const delivery = Number(order.platform_delivery_fee);
  const vendorAmount = round2(total + promo - commission - delivery);

  const posted = await postTransaction(client, {
    type: 'order_payment',
    referenceType: 'order',
    referenceId: orderId,
    idempotencyKey: `order_payment:${orderId}`,
    description: 'Customer payment held in escrow',
    entries: [
      { account: ACCOUNTS.mpesa, direction: 'debit', amount: total },
      { account: ACCOUNTS.promoExpense, direction: 'debit', amount: promo },
      { account: ACCOUNTS.storePending(order.store_id), direction: 'credit', amount: vendorAmount },
      { account: ACCOUNTS.commissionPending, direction: 'credit', amount: commission },
      { account: ACCOUNTS.deliveryPending, direction: 'credit', amount: delivery },
    ],
  });
  if (posted.duplicate) return;

  await client.query(
    `INSERT INTO escrow_holds (order_id, store_id, seller_id, vendor_amount, commission_amount, delivery_amount, promo_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId, order.store_id, order.seller_id, vendorAmount, commission, delivery, promo],
  );
  await client.query(`UPDATE orders SET escrow_status = 'held' WHERE id = $1`, [orderId]);
};

/** Starts the auto-confirm countdown once the order is delivered. */
export const startReleaseWindow = async (client: PoolClient, orderId: string): Promise<Date> => {
  const days = await getNumberSetting('escrow.auto_confirm_days', 7);
  const releaseAfter = new Date(Date.now() + days * 86_400_000);
  await client.query(`UPDATE escrow_holds SET release_after = $2, updated_at = NOW() WHERE order_id = $1`, [orderId, releaseAfter]);
  await client.query(`UPDATE orders SET auto_confirm_at = $2 WHERE id = $1`, [orderId, releaseAfter]);
  return releaseAfter;
};

/**
 * Moves whatever remains in escrow to the vendor's available balance and recognises the commission.
 * Refuses while a dispute is open. Idempotent.
 */
export const releaseEscrow = async (
  client: PoolClient,
  orderId: string,
  opts: { reason: string; actorId?: string | null; force?: boolean },
): Promise<boolean> => {
  const esc = await lockEscrow(client, orderId);
  if (esc.status === 'released' || esc.status === 'refunded') return false;
  if (esc.dispute_locked && !opts.force) {
    throw new AppError(409, 'Funds are locked while a dispute is open on this order.');
  }

  const vendor = round2(Number(esc.vendor_amount) - Number(esc.refunded_vendor));
  const commission = round2(Number(esc.commission_amount) - Number(esc.refunded_commission));
  const delivery = round2(Number(esc.delivery_amount) - Number(esc.refunded_delivery));

  await postTransaction(client, {
    type: 'escrow_release',
    referenceType: 'order',
    referenceId: orderId,
    idempotencyKey: `escrow_release:${orderId}`,
    description: `Escrow released (${opts.reason})`,
    createdBy: opts.actorId,
    entries: [
      { account: ACCOUNTS.storePending(esc.store_id), direction: 'debit', amount: vendor },
      { account: ACCOUNTS.storeAvailable(esc.store_id), direction: 'credit', amount: vendor },
      { account: ACCOUNTS.commissionPending, direction: 'debit', amount: commission },
      { account: ACCOUNTS.commissionRevenue, direction: 'credit', amount: commission },
      { account: ACCOUNTS.deliveryPending, direction: 'debit', amount: delivery },
      { account: ACCOUNTS.deliveryRevenue, direction: 'credit', amount: delivery },
    ],
  });

  await client.query(
    `UPDATE escrow_holds SET status = 'released', released_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [esc.id],
  );
  await client.query(`UPDATE orders SET escrow_status = 'released' WHERE id = $1`, [orderId]);
  return true;
};

/**
 * Returns money to the customer out of the vendor's side of escrow — or, if escrow has already
 * been released, out of the vendor's available balance (which may then go negative).
 * method 'wallet' credits store credit; 'original' books cash out via M-Pesa (paid out by finance).
 */
export const refundFromEscrow = async (
  client: PoolClient,
  opts: {
    orderId: string;
    refundId: string;
    amount: number;
    method: 'original' | 'wallet';
    actorId?: string | null;
    reason?: string;
  },
): Promise<void> => {
  const esc = await lockEscrow(client, opts.orderId);
  const orderRes = await client.query<{ user_id: string; total: string }>(
    'SELECT user_id, total FROM orders WHERE id = $1',
    [opts.orderId],
  );
  const order = orderRes.rows[0];

  const vendorRem = round2(Number(esc.vendor_amount) - Number(esc.refunded_vendor));
  const commRem = round2(Number(esc.commission_amount) - Number(esc.refunded_commission));
  const promoRem = round2(Number(esc.promo_amount) - Number(esc.refunded_promo));
  const deliveryRem = round2(Number(esc.delivery_amount) - Number(esc.refunded_delivery));
  const cashRem = round2(vendorRem + commRem + deliveryRem - promoRem);

  if (esc.status === 'refunded' || cashRem <= 0) throw new AppError(409, 'This order has already been fully refunded.');
  if (toCents(opts.amount) > toCents(cashRem)) {
    throw new AppError(400, `Refund exceeds the refundable amount (KSh ${cashRem}).`);
  }

  const parts = refundParts({
    refund: opts.amount,
    cashRemaining: cashRem,
    vendorRemaining: vendorRem,
    commissionRemaining: commRem,
    deliveryRemaining: deliveryRem,
    promoRemaining: promoRem,
  });

  const released = esc.status === 'released';
  const vendorAccount = released ? ACCOUNTS.storeAvailable(esc.store_id) : ACCOUNTS.storePending(esc.store_id);
  const commissionAccount = released ? ACCOUNTS.commissionRevenue : ACCOUNTS.commissionPending;
  const deliveryAccount = released ? ACCOUNTS.deliveryRevenue : ACCOUNTS.deliveryPending;
  const customerSide = opts.method === 'wallet' ? ACCOUNTS.wallet(order.user_id) : ACCOUNTS.mpesa;

  await postTransaction(client, {
    type: 'refund',
    referenceType: 'refund',
    referenceId: opts.refundId,
    idempotencyKey: `refund:${opts.refundId}`,
    description: opts.reason ?? 'Refund to customer',
    createdBy: opts.actorId,
    entries: [
      { account: vendorAccount, direction: 'debit', amount: parts.vendor },
      { account: commissionAccount, direction: 'debit', amount: parts.commission },
      { account: deliveryAccount, direction: 'debit', amount: parts.delivery },
      { account: ACCOUNTS.promoExpense, direction: 'credit', amount: parts.promo },
      { account: customerSide, direction: 'credit', amount: opts.amount },
    ],
  });

  const fullyRefunded = toCents(opts.amount) === toCents(cashRem);
  const nextStatus = fullyRefunded ? 'refunded' : released ? 'released' : 'partially_refunded';
  await client.query(
    `UPDATE escrow_holds
     SET refunded_vendor = refunded_vendor + $2,
         refunded_commission = refunded_commission + $3,
         refunded_promo = refunded_promo + $4,
         refunded_delivery = refunded_delivery + $6,
         status = $5,
         updated_at = NOW()
     WHERE id = $1`,
    [esc.id, parts.vendor, parts.commission, parts.promo, nextStatus, parts.delivery],
  );
  await client.query(`UPDATE orders SET escrow_status = $2 WHERE id = $1`, [opts.orderId, nextStatus]);
};

export const setDisputeLock = async (client: PoolClient, orderId: string, locked: boolean): Promise<void> => {
  await client.query(
    `UPDATE escrow_holds SET dispute_locked = $2, updated_at = NOW() WHERE order_id = $1`,
    [orderId, locked],
  );
};

/** Worker sweep: release every order whose auto-confirm window passed with no dispute. */
export const releaseDueEscrows = async (): Promise<number> => {
  const due = await pool.query<{ order_id: string }>(
    `SELECT order_id FROM escrow_holds
     WHERE status IN ('held','partially_refunded')
       AND release_after IS NOT NULL AND release_after <= NOW()
       AND dispute_locked = false
     LIMIT 100`,
  );

  let released = 0;
  for (const row of due.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (await releaseEscrow(client, row.order_id, { reason: 'auto-confirm window elapsed' })) {
        await client.query(
          `UPDATE orders SET status = CASE WHEN status = 'delivered' THEN 'completed' ELSE status END,
                             completed_at = COALESCE(completed_at, NOW()) WHERE id = $1`,
          [row.order_id],
        );
        released += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[escrow] auto-release failed for order ${row.order_id}:`, (err as Error).message);
    } finally {
      client.release();
    }
  }
  return released;
};
