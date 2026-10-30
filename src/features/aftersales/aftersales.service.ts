// src/features/aftersales/aftersales.service.ts
//
// Returns, refunds and disputes.
//   return:   requested → approved | rejected → received → (refund created) ; rejected → escalated (dispute)
//   refund:   pending → processed | rejected     (finance/admin approves; money moves via escrow/ledger)
//   dispute:  awaiting_vendor ⇄ awaiting_customer → under_review → resolved
// An open dispute locks the order's escrow, so funds can neither auto-release nor be paid out.
import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import { audit } from '../../services/audit.service';
import { refundFromEscrow, releaseEscrow, setDisputeLock, startReleaseWindow } from '../../services/escrow.service';
import { notify, notifyRoles } from '../../services/notification.service';
import { getNumberSetting } from '../../services/settings.service';
import { round2, toCents } from '../../services/money';

export interface Actor {
  id: string;
  role: string;
}

const STAFF = ['admin', 'super_admin', 'support', 'finance'];
const isStaff = (r: string) => STAFF.includes(r);

const tx = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

const sellerUserOfStore = async (c: PoolClient | typeof pool, storeId: string): Promise<string> => {
  const r = await c.query(`SELECT s.user_id FROM stores st JOIN sellers s ON s.id = st.seller_id WHERE st.id = $1`, [storeId]);
  return r.rows[0].user_id;
};

// ============================================================
// RETURNS
// ============================================================

export interface CreateReturnInput {
  order_id: string;
  order_item_id: string;
  quantity?: number;
  reason: string;
  description?: string;
  photos?: string[];
  preferred_resolution?: 'refund' | 'wallet';
}

export const createReturn = async (userId: string, input: CreateReturnInput) =>
  tx(async (c) => {
    const o = (await c.query(`SELECT id, user_id, store_id, status, delivered_at, order_number FROM orders WHERE id = $1 FOR UPDATE`, [input.order_id])).rows[0];
    if (!o || o.user_id !== userId) throw new AppError(404, 'Order not found.');
    if (!['delivered', 'completed'].includes(o.status)) throw new AppError(409, 'You can request a return once the order has been delivered.');

    const windowDays = await getNumberSetting('returns.window_days', 7);
    const deliveredAt = new Date(o.delivered_at ?? Date.now());
    if (Date.now() > deliveredAt.getTime() + windowDays * 86_400_000) {
      throw new AppError(409, `The ${windowDays}-day return window for this order has closed.`);
    }

    const item = (await c.query(`SELECT id, quantity FROM order_items WHERE id = $1 AND order_id = $2`, [input.order_item_id, input.order_id])).rows[0];
    if (!item) throw new AppError(404, 'Order item not found.');
    const qty = Math.min(input.quantity ?? item.quantity, item.quantity);

    const existing = await c.query(
      `SELECT 1 FROM returns WHERE order_item_id = $1 AND status NOT IN ('rejected','closed','refunded')`,
      [input.order_item_id],
    );
    if (existing.rows.length) throw new AppError(409, 'A return is already in progress for this item.');

    const r = (
      await c.query(
        `INSERT INTO returns (order_id, order_item_id, user_id, store_id, quantity, reason, description, photos, preferred_resolution, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'requested') RETURNING *`,
        [input.order_id, input.order_item_id, userId, o.store_id, qty, input.reason, input.description ?? null, JSON.stringify(input.photos ?? []), input.preferred_resolution ?? 'refund'],
      )
    ).rows[0];

    await audit({ actorId: userId, actorRole: 'customer', action: 'return.request', entityType: 'return', entityId: r.id }, c);
    const sellerUser = await sellerUserOfStore(c, o.store_id);
    await notify(
      { userId: sellerUser, type: 'return_requested', title: `Return requested on order ${o.order_number}`, body: `Reason: ${input.reason}`, link: '/seller/returns' },
      c,
    );
    return r;
  });

export const decideReturn = async (returnId: string, actor: Actor, accept: boolean, response?: string) =>
  tx(async (c) => {
    const r = (await c.query(`SELECT * FROM returns WHERE id = $1 FOR UPDATE`, [returnId])).rows[0];
    if (!r) throw new AppError(404, 'Return not found.');
    await assertStoreOwner(c, r.store_id, actor);
    if (!['requested', 'pending'].includes(r.status)) throw new AppError(409, 'This return has already been decided.');
    if (!accept && !response) throw new AppError(400, 'Please explain why the return is rejected.');

    await c.query(
      `UPDATE returns SET status = $2, vendor_response = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [returnId, accept ? 'approved' : 'rejected', response ?? null],
    );
    await audit({ actorId: actor.id, actorRole: actor.role, action: accept ? 'return.approve' : 'return.reject', entityType: 'return', entityId: returnId }, c);
    await notify(
      {
        userId: r.user_id,
        type: accept ? 'return_approved' : 'return_rejected',
        title: accept ? 'Your return was approved' : 'Your return was rejected',
        body: accept
          ? 'Send the item back to the seller and add the tracking number in your account.'
          : `The seller said: ${response}\nIf you disagree you can escalate this to Loom for review.`,
        link: `/account/returns`,
      },
      c,
    );
  });

export const addReturnTracking = async (returnId: string, userId: string, tracking: string) => {
  const res = await pool.query(
    `UPDATE returns SET return_tracking = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'approved' RETURNING id`,
    [returnId, userId, tracking],
  );
  if (!res.rows.length) throw new AppError(404, 'Approved return not found.');
};

/** Seller confirms the returned item arrived → a refund request is created for finance approval. */
export const markReturnReceived = async (returnId: string, actor: Actor, refundAmount?: number) =>
  tx(async (c) => {
    const r = (await c.query(`SELECT * FROM returns WHERE id = $1 FOR UPDATE`, [returnId])).rows[0];
    if (!r) throw new AppError(404, 'Return not found.');
    await assertStoreOwner(c, r.store_id, actor);
    if (r.status !== 'approved') throw new AppError(409, 'Only an approved return can be marked as received.');

    const item = (await c.query(`SELECT price, quantity FROM order_items WHERE id = $1`, [r.order_item_id])).rows[0];
    const maxAmount = round2(Number(item.price) * r.quantity);
    const amount = round2(refundAmount ?? maxAmount);
    if (amount <= 0 || toCents(amount) > toCents(maxAmount)) throw new AppError(400, `Refund must be between 0 and KSh ${maxAmount}.`);

    await c.query(`UPDATE returns SET status = 'received', received_at = NOW(), refund_amount = $2, updated_at = NOW() WHERE id = $1`, [returnId, amount]);
    const refund = await createRefundRow(c, {
      orderId: r.order_id, storeId: r.store_id, userId: r.user_id, amount,
      method: r.preferred_resolution === 'wallet' ? 'wallet' : 'original', reason: `Return: ${r.reason}`, requestedBy: actor.id, returnId,
    });
    await notifyRoles(['finance', 'admin', 'super_admin'], {
      type: 'refund_pending', title: 'Refund awaiting approval', body: `KSh ${amount} for a received return.`, link: '/admin/refunds', email: false,
    });
    return refund;
  });

export const escalateReturn = async (returnId: string, userId: string) =>
  tx(async (c) => {
    const r = (await c.query(`SELECT * FROM returns WHERE id = $1 AND user_id = $2 FOR UPDATE`, [returnId, userId])).rows[0];
    if (!r) throw new AppError(404, 'Return not found.');
    if (r.status !== 'rejected') throw new AppError(409, 'Only a rejected return can be escalated.');
    await c.query(`UPDATE returns SET status = 'escalated', updated_at = NOW() WHERE id = $1`, [returnId]);
    return openDisputeInTx(c, { id: userId, role: 'customer' }, {
      order_id: r.order_id, reason: 'Return rejected by seller', description: r.description ?? r.reason, returnId,
    });
  });

export const listReturns = async (opts: { userId?: string; storeUserId?: string; status?: string; all?: boolean }) => {
  const res = await pool.query(
    `SELECT r.*, o.order_number, oi.price AS item_price, p.name AS product_name, st.name AS store_name
     FROM returns r
     JOIN orders o ON o.id = r.order_id
     JOIN order_items oi ON oi.id = r.order_item_id
     JOIN products p ON p.id = oi.product_id
     JOIN stores st ON st.id = r.store_id
     JOIN sellers s ON s.id = st.seller_id
     WHERE ($1::uuid IS NULL OR r.user_id = $1)
       AND ($2::uuid IS NULL OR s.user_id = $2)
       AND ($3::text IS NULL OR r.status = $3)
     ORDER BY r.created_at DESC LIMIT 200`,
    [opts.userId ?? null, opts.storeUserId ?? null, opts.status ?? null],
  );
  return res.rows;
};

const assertStoreOwner = async (c: PoolClient, storeId: string, actor: Actor) => {
  if (isStaff(actor.role)) return;
  const r = await c.query(`SELECT 1 FROM stores st JOIN sellers s ON s.id = st.seller_id WHERE st.id = $1 AND s.user_id = $2`, [storeId, actor.id]);
  if (!r.rows.length) throw new AppError(403, 'This does not belong to your store.');
};

// ============================================================
// REFUNDS
// ============================================================

const createRefundRow = async (
  c: PoolClient,
  o: { orderId: string; storeId: string; userId: string; amount: number; method: 'original' | 'wallet'; reason: string; requestedBy: string; returnId?: string; disputeId?: string },
) =>
  (
    await c.query(
      `INSERT INTO refunds (order_id, store_id, user_id, return_id, dispute_id, amount, method, reason, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [o.orderId, o.storeId, o.userId, o.returnId ?? null, o.disputeId ?? null, o.amount, o.method, o.reason, o.requestedBy],
    )
  ).rows[0];

export const approveRefund = async (refundId: string, actor: Actor, opts: { method?: 'original' | 'wallet'; reference?: string }) =>
  tx(async (c) => {
    const rf = (await c.query(`SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [refundId])).rows[0];
    if (!rf) throw new AppError(404, 'Refund not found.');
    if (rf.status !== 'pending') throw new AppError(409, `This refund is already ${rf.status}.`);

    const method = opts.method ?? rf.method;
    if (method === 'original' && !opts.reference) {
      throw new AppError(400, 'Enter the M-Pesa reference of the money you sent back to the customer.');
    }

    await refundFromEscrow(c, { orderId: rf.order_id, refundId, amount: Number(rf.amount), method, actorId: actor.id, reason: rf.reason ?? undefined });
    await c.query(
      `UPDATE refunds SET status = 'processed', method = $2, reference = $3, approved_by = $4, processed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [refundId, method, opts.reference ?? null, actor.id],
    );
    if (rf.return_id) await c.query(`UPDATE returns SET status = 'refunded', updated_at = NOW() WHERE id = $1`, [rf.return_id]);

    const totals = (await c.query(`SELECT o.total, COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'processed'), 0) AS refunded FROM orders o LEFT JOIN refunds r ON r.order_id = o.id WHERE o.id = $1 GROUP BY o.total`, [rf.order_id])).rows[0];
    const full = toCents(Number(totals.refunded)) >= toCents(Number(totals.total));
    await c.query(`UPDATE orders SET payment_status = $2, refunded_at = CASE WHEN $3 THEN NOW() ELSE refunded_at END WHERE id = $1`, [rf.order_id, full ? 'refunded' : 'partially_refunded', full]);

    await audit({ actorId: actor.id, actorRole: actor.role, action: 'refund.approve', entityType: 'refund', entityId: refundId, metadata: { amount: rf.amount, method } }, c);
    await notify(
      {
        userId: rf.user_id, type: 'refund_processed', title: 'Your refund has been processed',
        body: method === 'wallet' ? `KSh ${rf.amount} was added to your Loom wallet.` : `KSh ${rf.amount} was sent back to your M-Pesa (ref ${opts.reference}).`,
        link: '/account/wallet', sms: `Loom: your refund of KSh ${rf.amount} has been processed.`,
      },
      c,
    );
  });

export const rejectRefund = async (refundId: string, actor: Actor, reason: string) => {
  const res = await pool.query(
    `UPDATE refunds SET status = 'rejected', approved_by = $2, reason = COALESCE(reason,'') || ' | rejected: ' || $3, updated_at = NOW()
     WHERE id = $1 AND status = 'pending' RETURNING user_id, return_id`,
    [refundId, actor.id, reason],
  );
  if (!res.rows.length) throw new AppError(404, 'Pending refund not found.');
  if (res.rows[0].return_id) await pool.query(`UPDATE returns SET status = 'closed', updated_at = NOW() WHERE id = $1`, [res.rows[0].return_id]);
  await audit({ actorId: actor.id, actorRole: actor.role, action: 'refund.reject', entityType: 'refund', entityId: refundId, metadata: { reason } });
};

export const listRefunds = async (status?: string) =>
  (
    await pool.query(
      `SELECT rf.*, o.order_number, u.full_name AS customer_name, st.name AS store_name
       FROM refunds rf JOIN orders o ON o.id = rf.order_id JOIN users u ON u.id = rf.user_id JOIN stores st ON st.id = rf.store_id
       WHERE ($1::text IS NULL OR rf.status = $1) ORDER BY rf.created_at DESC LIMIT 200`,
      [status ?? null],
    )
  ).rows;

// ============================================================
// DISPUTES
// ============================================================

export interface OpenDisputeInput {
  order_id: string;
  reason: string;
  description?: string;
  returnId?: string;
  evidence?: { url: string; public_id?: string; mime?: string }[];
}

const openDisputeInTx = async (c: PoolClient, actor: Actor, input: OpenDisputeInput) => {
  const o = (await c.query(`SELECT id, user_id, store_id, seller_id, status, order_number, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [input.order_id])).rows[0];
  if (!o) throw new AppError(404, 'Order not found.');
  const sellerUser = await sellerUserOfStore(c, o.store_id);
  const role: 'customer' | 'seller' | null = actor.id === o.user_id ? 'customer' : actor.id === sellerUser ? 'seller' : null;
  if (!role) throw new AppError(403, 'You can only open a dispute on your own orders.');
  if (o.payment_status !== 'paid' && o.payment_status !== 'partially_refunded') throw new AppError(409, 'Only paid orders can be disputed.');
  if (!['shipped', 'delivered', 'completed', 'processing', 'paid'].includes(o.status)) throw new AppError(409, 'This order cannot be disputed in its current state.');

  const hours = await getNumberSetting('disputes.response_hours', 72);
  const respondBy = new Date(Date.now() + hours * 3_600_000);
  const d = (
    await c.query(
      `INSERT INTO disputes (order_id, store_id, customer_id, opened_by, opened_by_role, reason, description, status, respond_by, return_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [o.id, o.store_id, o.user_id, actor.id, role, input.reason, input.description ?? null, role === 'customer' ? 'awaiting_vendor' : 'awaiting_customer', respondBy, input.returnId ?? null],
    )
  ).rows[0];

  const first = (
    await c.query(`INSERT INTO dispute_messages (dispute_id, sender_id, sender_role, body) VALUES ($1,$2,$3,$4) RETURNING id`, [d.id, actor.id, role, input.description || input.reason])
  ).rows[0];
  for (const ev of input.evidence ?? []) {
    await c.query(`INSERT INTO dispute_evidence (dispute_id, message_id, url, public_id, mime, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [d.id, first.id, ev.url, ev.public_id ?? null, ev.mime ?? null, actor.id]);
  }

  await setDisputeLock(c, o.id, true); // funds frozen until resolved
  await audit({ actorId: actor.id, actorRole: role, action: 'dispute.open', entityType: 'dispute', entityId: d.id, metadata: { order: o.order_number, reason: input.reason } }, c);

  const other = role === 'customer' ? sellerUser : o.user_id;
  await notify({ userId: other, type: 'dispute_opened', title: `A dispute was opened on order ${o.order_number}`, body: `Reason: ${input.reason}\nPlease respond within ${hours} hours.`, link: `/${role === 'customer' ? 'seller' : 'account'}/disputes/${d.id}` }, c);
  return d;
};

export const openDispute = (actor: Actor, input: OpenDisputeInput) => tx((c) => openDisputeInTx(c, actor, input));

const loadDisputeFor = async (c: PoolClient | typeof pool, disputeId: string, actor: Actor) => {
  const d = (await c.query(`SELECT d.*, o.order_number, s.user_id AS seller_user FROM disputes d JOIN orders o ON o.id = d.order_id JOIN stores st ON st.id = d.store_id JOIN sellers s ON s.id = st.seller_id WHERE d.id = $1`, [disputeId])).rows[0];
  if (!d) throw new AppError(404, 'Dispute not found.');
  const role = actor.id === d.customer_id ? 'customer' : actor.id === d.seller_user ? 'seller' : isStaff(actor.role) ? 'staff' : null;
  if (!role) throw new AppError(403, 'You are not part of this dispute.');
  return { d, role: role as 'customer' | 'seller' | 'staff' };
};

export const getDispute = async (disputeId: string, actor: Actor) => {
  const { d, role } = await loadDisputeFor(pool, disputeId, actor);
  const [messages, evidence] = await Promise.all([
    pool.query(`SELECT m.*, u.full_name AS sender_name FROM dispute_messages m JOIN users u ON u.id = m.sender_id WHERE dispute_id = $1 ORDER BY created_at`, [disputeId]),
    pool.query(`SELECT * FROM dispute_evidence WHERE dispute_id = $1 ORDER BY created_at`, [disputeId]),
  ]);
  return { ...d, viewer_role: role, messages: messages.rows, evidence: evidence.rows };
};

export const addDisputeMessage = async (disputeId: string, actor: Actor, body: string, evidence: { url: string; public_id?: string; mime?: string }[] = []) =>
  tx(async (c) => {
    const { d, role } = await loadDisputeFor(c, disputeId, actor);
    if (['resolved', 'closed'].includes(d.status)) throw new AppError(409, 'This dispute is closed.');

    const m = (await c.query(`INSERT INTO dispute_messages (dispute_id, sender_id, sender_role, body) VALUES ($1,$2,$3,$4) RETURNING *`, [disputeId, actor.id, role, body])).rows[0];
    for (const ev of evidence) {
      await c.query(`INSERT INTO dispute_evidence (dispute_id, message_id, url, public_id, mime, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [disputeId, m.id, ev.url, ev.public_id ?? null, ev.mime ?? null, actor.id]);
    }

    // A party answering hands the ball to the other side (and restarts the clock). Staff replies don't change turn.
    if (role !== 'staff' && d.status !== 'under_review') {
      const hours = await getNumberSetting('disputes.response_hours', 72);
      await c.query(`UPDATE disputes SET status = $2, respond_by = $3, updated_at = NOW() WHERE id = $1`, [disputeId, role === 'customer' ? 'awaiting_vendor' : 'awaiting_customer', new Date(Date.now() + hours * 3_600_000)]);
    } else {
      await c.query(`UPDATE disputes SET updated_at = NOW() WHERE id = $1`, [disputeId]);
    }

    const recipients = new Set<string>();
    if (role !== 'customer') recipients.add(d.customer_id);
    if (role !== 'seller') recipients.add(d.seller_user);
    for (const u of recipients) {
      await notify({ userId: u, type: 'dispute_message', title: `New message on dispute (order ${d.order_number})`, body: body.slice(0, 200), link: `/${u === d.customer_id ? 'account' : 'seller'}/disputes/${disputeId}` }, c);
    }
    return m;
  });

export const escalateDispute = async (disputeId: string, actor: Actor) =>
  tx(async (c) => {
    const { d, role } = await loadDisputeFor(c, disputeId, actor);
    if (role === 'staff') throw new AppError(400, 'Already with the Loom team.');
    if (['resolved', 'closed', 'under_review'].includes(d.status)) throw new AppError(409, 'This dispute cannot be escalated.');
    await c.query(`UPDATE disputes SET status = 'under_review', escalated_at = NOW(), updated_at = NOW() WHERE id = $1`, [disputeId]);
    await audit({ actorId: actor.id, actorRole: role, action: 'dispute.escalate', entityType: 'dispute', entityId: disputeId }, c);
    await notifyRoles(['support', 'admin', 'super_admin'], { type: 'dispute_review', title: 'Dispute needs review', body: `Order ${d.order_number}`, link: `/admin/disputes/${disputeId}`, email: false });
  });

export type Resolution = 'full_refund' | 'partial_refund' | 'release_to_vendor' | 'replacement';

export const resolveDispute = async (disputeId: string, actor: Actor, input: { resolution: Resolution; amount?: number; notes: string }) =>
  tx(async (c) => {
    if (!['admin', 'super_admin', 'support'].includes(actor.role)) throw new AppError(403, 'Only the support team can resolve disputes.');
    const { d } = await loadDisputeFor(c, disputeId, actor);
    if (['resolved', 'closed'].includes(d.status)) throw new AppError(409, 'This dispute is already resolved.');

    const esc = (await c.query(`SELECT * FROM escrow_holds WHERE order_id = $1 FOR UPDATE`, [d.order_id])).rows[0];
    if (!esc) throw new AppError(409, 'No escrow exists for this order.');
    const cashRemaining = round2(Number(esc.vendor_amount) + Number(esc.commission_amount) + Number(esc.delivery_amount) - Number(esc.promo_amount) - Number(esc.refunded_vendor) - Number(esc.refunded_commission) - Number(esc.refunded_delivery) + Number(esc.refunded_promo));

    let refundAmount = 0;
    if (input.resolution === 'full_refund') refundAmount = cashRemaining;
    if (input.resolution === 'partial_refund') {
      refundAmount = round2(input.amount ?? 0);
      if (refundAmount <= 0 || toCents(refundAmount) >= toCents(cashRemaining)) throw new AppError(400, `A partial refund must be above 0 and below KSh ${cashRemaining}.`);
    }

    if (refundAmount > 0) {
      const refund = await createRefundRow(c, { orderId: d.order_id, storeId: d.store_id, userId: d.customer_id, amount: refundAmount, method: 'wallet', reason: `Dispute ${input.resolution}: ${input.notes}`, requestedBy: actor.id, disputeId });
      await refundFromEscrow(c, { orderId: d.order_id, refundId: refund.id, amount: refundAmount, method: 'wallet', actorId: actor.id, reason: 'Dispute resolution' });
      await c.query(`UPDATE refunds SET status = 'processed', approved_by = $2, processed_at = NOW() WHERE id = $1`, [refund.id, actor.id]);
      await c.query(`UPDATE orders SET payment_status = $2 WHERE id = $1`, [d.order_id, input.resolution === 'full_refund' ? 'refunded' : 'partially_refunded']);
    }

    await setDisputeLock(c, d.order_id, false);
    if (input.resolution === 'replacement') {
      await startReleaseWindow(c, d.order_id); // vendor reships; funds stay held for a fresh window
    } else if (input.resolution !== 'full_refund') {
      await releaseEscrow(c, d.order_id, { reason: `dispute ${input.resolution}`, actorId: actor.id, force: true });
      await c.query(`UPDATE orders SET status = CASE WHEN status IN ('delivered','shipped') THEN 'completed' ELSE status END, completed_at = COALESCE(completed_at, NOW()) WHERE id = $1`, [d.order_id]);
    } else {
      await c.query(`UPDATE orders SET status = 'refunded', refunded_at = NOW() WHERE id = $1`, [d.order_id]);
    }

    await c.query(
      `UPDATE disputes SET status = 'resolved', resolution = $2, resolution_amount = $3, resolution_notes = $4, resolved_by = $5, resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [disputeId, input.resolution, refundAmount || null, input.notes, actor.id],
    );
    if (d.return_id) await c.query(`UPDATE returns SET status = 'closed', updated_at = NOW() WHERE id = $1`, [d.return_id]);

    await audit({ actorId: actor.id, actorRole: actor.role, action: 'dispute.resolve', entityType: 'dispute', entityId: disputeId, metadata: { ...input, refundAmount } }, c);
    for (const u of [d.customer_id, d.seller_user]) {
      await notify({ userId: u, type: 'dispute_resolved', title: `Dispute resolved (order ${d.order_number})`, body: `Outcome: ${input.resolution.replace(/_/g, ' ')}.\n${input.notes}`, link: `/${u === d.customer_id ? 'account' : 'seller'}/disputes/${disputeId}` }, c);
    }
  });

export const listDisputes = async (opts: { userId?: string; staff?: boolean; status?: string }) =>
  (
    await pool.query(
      `SELECT d.*, o.order_number, o.total, st.name AS store_name, cu.full_name AS customer_name
       FROM disputes d JOIN orders o ON o.id = d.order_id JOIN stores st ON st.id = d.store_id
       JOIN sellers s ON s.id = st.seller_id JOIN users cu ON cu.id = d.customer_id
       WHERE ($1::boolean OR d.customer_id = $2 OR s.user_id = $2)
         AND ($3::text IS NULL OR d.status = $3)
       ORDER BY (d.status IN ('under_review')) DESC, d.updated_at DESC LIMIT 200`,
      [!!opts.staff, opts.userId ?? null, opts.status ?? null],
    )
  ).rows;

/** Worker sweep: a party that misses the response deadline escalates the dispute to the support team. */
export const escalateOverdueDisputes = async (): Promise<number> => {
  const due = await pool.query<{ id: string; order_number: string }>(
    `UPDATE disputes d SET status = 'under_review', escalated_at = NOW(), updated_at = NOW()
     FROM orders o
     WHERE o.id = d.order_id AND d.status IN ('awaiting_vendor','awaiting_customer') AND d.respond_by < NOW()
     RETURNING d.id, o.order_number`,
  );
  for (const d of due.rows) {
    await notifyRoles(['support', 'admin', 'super_admin'], { type: 'dispute_review', title: 'Dispute auto-escalated', body: `Order ${d.order_number}: no response before the deadline.`, link: `/admin/disputes/${d.id}`, email: false });
  }
  return due.rows.length;
};

