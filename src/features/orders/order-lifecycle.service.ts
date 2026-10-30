// src/features/orders/order-lifecycle.service.ts
//
// Every state change of a paid order goes through here so money, stock and notifications
// can never drift apart from the order status:
//   payment confirmed → escrow held → seller ships → delivered → customer confirms / auto-confirm → released
//   unpaid + expired / failed / cancelled → stock restored; paid + cancelled → refunded from escrow
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import { audit } from '../../services/audit.service';
import { holdPaymentInEscrow, refundFromEscrow, releaseEscrow, startReleaseWindow } from '../../services/escrow.service';
import { notify } from '../../services/notification.service';
import { OrderStatus, isStatusTransitionValid } from './order.types';

interface Actor {
  id: string;
  role: string;
}

const isStaff = (role: string) => ['admin', 'super_admin', 'support'].includes(role);

interface LockedOrder {
  id: string;
  order_number: string;
  user_id: string;
  store_id: string;
  seller_id: string;
  status: OrderStatus;
  payment_status: string;
  total: string;
  shipping: Record<string, unknown>;
  stock_restored: boolean;
}

const lockOrder = async (client: PoolClient, orderId: string): Promise<LockedOrder> => {
  const res = await client.query<LockedOrder>(
    `SELECT id, order_number, user_id, store_id, seller_id, status, payment_status, total, shipping, stock_restored
     FROM orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [orderId],
  );
  if (!res.rows[0]) throw new AppError(404, 'Order not found.');
  return res.rows[0];
};

const assertSellerOfOrder = async (client: PoolClient, order: LockedOrder, actor: Actor): Promise<void> => {
  if (isStaff(actor.role)) return;
  const res = await client.query(`SELECT 1 FROM sellers WHERE id = $1 AND user_id = $2`, [order.seller_id, actor.id]);
  if (res.rows.length === 0) throw new AppError(403, 'This order does not belong to your store.');
};

const assertTransition = (from: OrderStatus, to: OrderStatus) => {
  if (!isStatusTransitionValid(from, to)) throw new AppError(409, `Order cannot move from "${from}" to "${to}".`);
};

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/** Puts reserved stock back. Guarded by orders.stock_restored so it can only ever happen once. */
export const restoreOrderStock = async (client: PoolClient, orderId: string): Promise<void> => {
  const flag = await client.query(
    `UPDATE orders SET stock_restored = true WHERE id = $1 AND stock_restored = false RETURNING id`,
    [orderId],
  );
  if (flag.rows.length === 0) return;

  const items = await client.query<{ product_id: string; variant_id: string | null; quantity: number }>(
    `SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = $1`,
    [orderId],
  );
  for (const it of items.rows) {
    if (it.variant_id) {
      await client.query(`UPDATE product_variants SET stock_quantity = stock_quantity + $1 WHERE id = $2`, [it.quantity, it.variant_id]);
    } else {
      await client.query(`UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2`, [it.quantity, it.product_id]);
    }
  }
  // un-count flash-sale units and free the coupon for this order
  await client.query(
    `UPDATE flash_sale_items fi SET sold = GREATEST(0, sold - oi.quantity)
     FROM order_items oi, flash_sales fs
     WHERE oi.order_id = $1 AND oi.variant_id IS NULL AND fi.product_id = oi.product_id
       AND fs.id = fi.flash_sale_id AND fs.is_active AND fs.starts_at <= NOW() AND fs.ends_at >= NOW()`,
    [orderId],
  );
  const red = await client.query<{ coupon_id: string }>(
    `DELETE FROM coupon_redemptions WHERE order_id = $1 RETURNING coupon_id`,
    [orderId],
  );
  for (const r of red.rows) {
    await client.query(`UPDATE coupons SET used_count = GREATEST(0, used_count - 1) WHERE id = $1`, [r.coupon_id]);
  }
};

// ---------------------------------------------------------------------------
// Payment events (called from the M-Pesa callback)
// ---------------------------------------------------------------------------

export const markPaymentGroupPaid = async (
  paymentGroupId: string,
  mpesaReceipt: string | null,
  transactionId: string,
): Promise<void> => {
  const client = await pool.connect();
  const paidOrders: { id: string; user_id: string; store_id: string; order_number: string; total: string; seller_user: string }[] = [];
  try {
    await client.query('BEGIN');

    const orders = await client.query(
      `SELECT o.id, o.user_id, o.store_id, o.order_number, o.total, o.payment, o.status, o.payment_status, s.user_id AS seller_user
       FROM orders o JOIN sellers s ON s.id = o.seller_id
       WHERE o.payment_group_id = $1 AND o.deleted_at IS NULL FOR UPDATE OF o`,
      [paymentGroupId],
    );

    for (const row of orders.rows) {
      if (row.payment_status === 'paid') continue; // replayed callback — already processed

      // Late payment on an order we already expired/cancelled: take the stock back out again is not
      // safe, so keep it cancelled and flag it for a manual refund instead.
      if (row.status === 'cancelled' || row.status === 'failed') {
        await client.query(
          `INSERT INTO fraud_flags (entity_type, entity_id, signal, severity, details)
           VALUES ('order', $1, 'payment_after_cancel', 'high', $2::jsonb) ON CONFLICT DO NOTHING`,
          [row.id, JSON.stringify({ receipt: mpesaReceipt ?? 'unknown (confirmed by status query)', note: 'Money received for a cancelled order — refund the customer' })],
        );
        continue;
      }

      const nextPayment = {
        ...(row.payment || {}),
        method: 'mpesa',
        status: 'paid',
        transaction_id: transactionId,
        mpesa_receipt: mpesaReceipt,
        paid_at: new Date(),
      };
      await client.query(
        `UPDATE orders
         SET payment = $1::jsonb, payment_status = 'paid',
             status = CASE WHEN status IN ('pending','payment_pending','failed') THEN 'paid' ELSE status END,
             payment_confirmed_at = NOW(), expires_at = NULL, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(nextPayment), row.id],
      );
      await holdPaymentInEscrow(client, row.id);
      paidOrders.push(row);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  for (const o of paidOrders) {
    await notify({
      userId: o.user_id,
      type: 'order_paid',
      title: `Payment received for order ${o.order_number}`,
      body: `We received KSh ${Number(o.total).toLocaleString('en-KE')}. The seller has been notified and will ship your order soon.`,
      link: `/account/orders/${o.id}`,
      sms: `Loom: payment received for order ${o.order_number}. Thank you!`,
    });
    await notify({
      userId: o.seller_user,
      type: 'order_new',
      title: `New order ${o.order_number}`,
      body: 'A customer has paid for an order. Pack it and mark it as shipped with a tracking number.',
      link: `/seller/orders`,
      sms: `Loom: new paid order ${o.order_number}. Open your seller dashboard to ship it.`,
    });
  }
};

export const markPaymentGroupFailed = async (paymentGroupId: string, reason: string): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orders = await client.query<{ id: string }>(
      `SELECT id FROM orders
       WHERE payment_group_id = $1 AND deleted_at IS NULL AND payment_status <> 'paid' AND status NOT IN ('cancelled','failed')
       FOR UPDATE`,
      [paymentGroupId],
    );
    for (const o of orders.rows) {
      await client.query(
        `UPDATE orders SET payment_status = 'failed', status = 'failed', updated_at = NOW() WHERE id = $1`,
        [o.id],
      );
      await restoreOrderStock(client, o.id);
    }
    await client.query('COMMIT');
    void reason;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/** Worker sweep: cancel unpaid orders past their expiry and return their stock. */
export const expireUnpaidOrders = async (): Promise<number> => {
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM orders
     WHERE payment_status IN ('pending', 'initiated') AND expires_at IS NOT NULL AND expires_at < NOW()
       AND status IN ('pending','payment_pending','failed') AND deleted_at IS NULL
     LIMIT 200`,
  );
  let expired = 0;
  for (const row of due.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const o = await lockOrder(client, row.id);
      if (['pending', 'initiated'].includes(o.payment_status)) {
        await client.query(
          `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
                  admin_notes = COALESCE(admin_notes || E'\\n', '') || 'Auto-cancelled: payment not received in time'
           WHERE id = $1`,
          [row.id],
        );
        await restoreOrderStock(client, row.id);
        expired += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[orders] expiry failed for', row.id, (err as Error).message);
    } finally {
      client.release();
    }
  }
  return expired;
};

// ---------------------------------------------------------------------------
// Cancellation (before shipping only; paid orders are refunded automatically)
// ---------------------------------------------------------------------------

export const cancelOrderWithRefund = async (orderId: string, actor: Actor, reason?: string): Promise<void> => {
  const client = await pool.connect();
  let notifyUser: { userId: string; orderNumber: string; refunded: number } | null = null;
  try {
    await client.query('BEGIN');
    const order = await lockOrder(client, orderId);

    const isOwner = order.user_id === actor.id;
    if (!isOwner && !isStaff(actor.role)) {
      await assertSellerOfOrder(client, order, actor); // sellers may cancel their own orders
    }
    if (!['pending', 'payment_pending', 'paid', 'processing', 'failed'].includes(order.status)) {
      throw new AppError(409, 'This order can no longer be cancelled because it has already shipped.');
    }

    const wasPaid = order.payment_status === 'paid';
    await client.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
              admin_notes = COALESCE(admin_notes || E'\\n', '') || $2
       WHERE id = $1`,
      [orderId, `Cancelled by ${actor.role}: ${reason ?? 'no reason given'}`],
    );
    await restoreOrderStock(client, orderId);

    let refunded = 0;
    if (wasPaid) {
      refunded = Number(order.total);
      const refundId = randomUUID();
      await client.query(
        `INSERT INTO refunds (id, order_id, store_id, user_id, amount, method, status, reason, requested_by, approved_by, processed_at)
         VALUES ($1,$2,$3,$4,$5,'wallet','processed',$6,$7,$7,NOW())`,
        [refundId, orderId, order.store_id, order.user_id, refunded, `Order cancelled: ${reason ?? ''}`.trim(), actor.id],
      );
      await refundFromEscrow(client, {
        orderId, refundId, amount: refunded, method: 'wallet', actorId: actor.id, reason: 'Order cancelled before shipping',
      });
      await client.query(`UPDATE orders SET payment_status = 'refunded', refunded_at = NOW() WHERE id = $1`, [orderId]);
    }

    await audit({ actorId: actor.id, actorRole: actor.role, action: 'order.cancel', entityType: 'order', entityId: orderId, metadata: { reason, refunded } }, client);
    await client.query('COMMIT');
    notifyUser = { userId: order.user_id, orderNumber: order.order_number, refunded };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (notifyUser) {
    await notify({
      userId: notifyUser.userId,
      type: 'order_cancelled',
      title: `Order ${notifyUser.orderNumber} cancelled`,
      body: notifyUser.refunded
        ? `KSh ${notifyUser.refunded.toLocaleString('en-KE')} has been refunded to your Loom wallet and can be used on your next order.`
        : 'Your order was cancelled and you have not been charged.',
      link: `/account/orders/${orderId}`,
    });
  }
};

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

export const shipOrder = async (
  orderId: string,
  actor: Actor,
  input: { carrier: string; tracking_number: string; tracking_url?: string },
): Promise<void> => {
  const client = await pool.connect();
  let info: { userId: string; orderNumber: string } | null = null;
  try {
    await client.query('BEGIN');
    const order = await lockOrder(client, orderId);
    await assertSellerOfOrder(client, order, actor);
    if (order.payment_status !== 'paid') throw new AppError(409, 'The customer has not paid for this order yet.');

    if (order.status === 'paid') {
      await client.query(`UPDATE orders SET status = 'processing', processed_at = NOW() WHERE id = $1`, [orderId]);
      order.status = 'processing';
    }
    assertTransition(order.status, 'shipped');

    const shipping = { ...order.shipping, carrier: input.carrier, tracking_number: input.tracking_number, tracking_url: input.tracking_url, shipped_at: new Date() };
    await client.query(
      `UPDATE orders SET status = 'shipped', fulfillment_status = 'shipped', shipped_at = NOW(),
              carrier = $2, tracking_number = $3, shipping = $4::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [orderId, input.carrier, input.tracking_number, JSON.stringify(shipping)],
    );
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'order.ship', entityType: 'order', entityId: orderId, metadata: input }, client);
    await client.query('COMMIT');
    info = { userId: order.user_id, orderNumber: order.order_number };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await notify({
    userId: info.userId,
    type: 'order_shipped',
    title: `Order ${info.orderNumber} is on its way`,
    body: `Carrier: ${input.carrier}\nTracking number: ${input.tracking_number}`,
    link: `/account/orders/${orderId}`,
    sms: `Loom: order ${info.orderNumber} shipped via ${input.carrier}, tracking ${input.tracking_number}.`,
  });
};

/** Accept a paid order and start preparing it (paid → processing). */
export const acceptOrder = async (orderId: string, actor: Actor): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = await lockOrder(client, orderId);
    await assertSellerOfOrder(client, order, actor);
    if (order.payment_status !== 'paid') throw new AppError(409, 'The customer has not paid for this order yet.');
    assertTransition(order.status, 'processing');
    await client.query(`UPDATE orders SET status = 'processing', processed_at = NOW(), updated_at = NOW() WHERE id = $1`, [orderId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/** Seller/courier marks the parcel delivered: starts the auto-confirm countdown. */
export const markDelivered = async (orderId: string, actor: Actor): Promise<void> => {
  const client = await pool.connect();
  let info: { userId: string; orderNumber: string; releaseAfter: Date } | null = null;
  try {
    await client.query('BEGIN');
    const order = await lockOrder(client, orderId);
    await assertSellerOfOrder(client, order, actor);
    assertTransition(order.status, 'delivered');
    await client.query(
      `UPDATE orders SET status = 'delivered', fulfillment_status = 'delivered', delivered_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [orderId],
    );
    const releaseAfter = await startReleaseWindow(client, orderId);
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'order.delivered', entityType: 'order', entityId: orderId }, client);
    await client.query('COMMIT');
    info = { userId: order.user_id, orderNumber: order.order_number, releaseAfter };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await notify({
    userId: info.userId,
    type: 'order_delivered',
    title: `Order ${info.orderNumber} was delivered`,
    body: `Please confirm you received it. If you don't, payment is released to the seller on ${info.releaseAfter.toLocaleDateString('en-KE')}. Have a problem? Open a dispute before then.`,
    link: `/account/orders/${orderId}`,
  });
};

/** Customer confirms receipt: escrow is released to the vendor right away (unless disputed). */
export const confirmDelivery = async (orderId: string, userId: string): Promise<void> => {
  const client = await pool.connect();
  let info: { sellerUser: string; orderNumber: string } | null = null;
  try {
    await client.query('BEGIN');
    const order = await lockOrder(client, orderId);
    if (order.user_id !== userId) throw new AppError(403, 'This is not your order.');
    if (!['shipped', 'delivered'].includes(order.status)) {
      throw new AppError(409, 'You can confirm delivery once the order has shipped.');
    }
    await client.query(
      `UPDATE orders SET status = 'completed', fulfillment_status = 'delivered',
              delivered_at = COALESCE(delivered_at, NOW()), delivery_confirmed_at = NOW(),
              completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [orderId],
    );
    await releaseEscrow(client, orderId, { reason: 'customer confirmed delivery', actorId: userId });
    await audit({ actorId: userId, actorRole: 'customer', action: 'order.confirm_delivery', entityType: 'order', entityId: orderId }, client);
    const seller = await client.query(`SELECT user_id FROM sellers WHERE id = $1`, [order.seller_id]);
    await client.query('COMMIT');
    info = { sellerUser: seller.rows[0].user_id, orderNumber: order.order_number };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await notify({
    userId: info.sellerUser,
    type: 'escrow_released',
    title: `Payment released for order ${info.orderNumber}`,
    body: 'The customer confirmed delivery. Your earnings are now in your available balance.',
    link: '/seller/payouts',
  });
};
