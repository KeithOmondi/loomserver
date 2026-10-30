// src/features/payouts/payouts.service.ts
//
// Vendor payouts. Available balance (from the ledger) is reserved the moment a payout is created,
// so it can never be paid twice:
//   create:  Dr store:available / Cr payouts_clearing            (money reserved)
//   paid:    Dr payouts_clearing / Cr M-Pesa clearing            (cash leaves the platform)
//   failed:  Dr payouts_clearing / Cr store:available            (reservation returned)
// Batches are generated automatically on the schedule, but nothing is paid until finance approves.
import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import { audit } from '../../services/audit.service';
import { ACCOUNTS, getStoreBalances, postTransaction } from '../../services/ledger.service';
import { notify, notifyRoles } from '../../services/notification.service';
import { getNumberSetting, getSetting } from '../../services/settings.service';
import { round2, toCents } from '../../services/money';

interface Actor {
  id: string;
  role: string;
}

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

// ---------------------------------------------------------------------------
// Vendor-facing
// ---------------------------------------------------------------------------

export const getSellerStores = async (userId: string) =>
  (
    await pool.query(
      `SELECT st.id AS store_id, st.name, s.id AS seller_id, s.payout_method, s.mpesa_phone, s.bank_name,
              s.bank_account_name, s.bank_account_number, s.payout_schedule, s.minimum_payout
       FROM stores st JOIN sellers s ON s.id = st.seller_id
       WHERE s.user_id = $1 AND st.deleted_at IS NULL`,
      [userId],
    )
  ).rows;

export const getPayoutSummary = async (userId: string) => {
  const stores = await getSellerStores(userId);
  const minimum = await getNumberSetting('payout.minimum_amount', 500);
  const out = [];
  for (const st of stores) {
    const b = await getStoreBalances(st.store_id);
    const hold = await pool.query(`SELECT reason FROM balance_holds WHERE store_id = $1 AND active`, [st.store_id]);
    const lifetime = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS paid FROM payouts WHERE store_id = $1 AND status = 'paid'`,
      [st.store_id],
    );
    out.push({
      store_id: st.store_id,
      store_name: st.name,
      pending: b.pending,
      available: b.available,
      in_payout: b.inPayout,
      lifetime_paid: Number(lifetime.rows[0].paid),
      minimum_payout: Math.max(minimum, Number(st.minimum_payout ?? 0)),
      on_hold: hold.rows.length > 0,
      hold_reason: hold.rows[0]?.reason ?? null,
      payout_method: st.payout_method,
      payout_schedule: st.payout_schedule,
      has_payout_details: hasPayoutDetails(st),
      mpesa_phone: st.mpesa_phone,
      bank_name: st.bank_name,
      bank_account_name: st.bank_account_name,
      bank_account_number: st.bank_account_number ? `••••${String(st.bank_account_number).slice(-4)}` : null,
    });
  }
  return out;
};

export const listStorePayouts = async (userId: string) =>
  (
    await pool.query(
      `SELECT p.id, p.amount, p.method, p.status, p.reference, p.failure_reason, p.paid_at, p.created_at, st.name AS store_name
       FROM payouts p JOIN stores st ON st.id = p.store_id JOIN sellers s ON s.id = p.seller_id
       WHERE s.user_id = $1 ORDER BY p.created_at DESC LIMIT 200`,
      [userId],
    )
  ).rows;

export const updatePayoutSettings = async (
  userId: string,
  input: { payout_method: 'mpesa' | 'bank'; mpesa_phone?: string; bank_name?: string; bank_account_name?: string; bank_account_number?: string; payout_schedule?: 'weekly' | 'monthly' },
) => {
  if (input.payout_method === 'mpesa' && !/^(\+?254|0)\d{9}$/.test(input.mpesa_phone ?? '')) {
    throw new AppError(400, 'Enter a valid Safaricom number, e.g. 0712345678.');
  }
  if (input.payout_method === 'bank' && !(input.bank_name && input.bank_account_name && input.bank_account_number)) {
    throw new AppError(400, 'Bank name, account name and account number are all required.');
  }
  const res = await pool.query(
    `UPDATE sellers SET payout_method = $2, mpesa_phone = COALESCE($3, mpesa_phone),
            bank_name = COALESCE($4, bank_name), bank_account_name = COALESCE($5, bank_account_name),
            bank_account_number = COALESCE($6, bank_account_number),
            payout_schedule = COALESCE($7, payout_schedule), updated_at = NOW()
     WHERE user_id = $1 RETURNING id`,
    [userId, input.payout_method, input.mpesa_phone ?? null, input.bank_name ?? null, input.bank_account_name ?? null, input.bank_account_number ?? null, input.payout_schedule ?? null],
  );
  if (!res.rows.length) throw new AppError(404, 'Seller profile not found.');
  await audit({ actorId: userId, actorRole: 'seller', action: 'payout.settings_update', entityType: 'seller', entityId: res.rows[0].id, metadata: { method: input.payout_method } });
};

/** Downloadable statement: every ledger movement on the vendor's accounts in a date range. */
export const buildStatementCsv = async (userId: string, from: Date, to: Date): Promise<string> => {
  const rows = await pool.query(
    `SELECT e.created_at, st.name AS store, t.type, COALESCE(t.description,'') AS description,
            a.code AS account, e.direction, e.amount,
            COALESCE(o.order_number, '') AS order_number
     FROM ledger_entries e
     JOIN ledger_accounts a ON a.id = e.account_id
     JOIN ledger_transactions t ON t.id = e.transaction_id
     JOIN stores st ON st.id = a.owner_id
     JOIN sellers s ON s.id = st.seller_id
     LEFT JOIN orders o ON t.reference_type = 'order' AND o.id = t.reference_id
     WHERE a.owner_type = 'store' AND s.user_id = $1 AND e.created_at >= $2 AND e.created_at < $3
     ORDER BY e.created_at, e.id`,
    [userId, from, to],
  );
  return toCsv(
    ['Date', 'Store', 'Type', 'Description', 'Account', 'Direction', 'Amount (KES)', 'Order'],
    rows.rows.map((r) => [new Date(r.created_at).toISOString(), r.store, r.type, r.description, String(r.account).split(':').pop(), r.direction, Number(r.amount).toFixed(2), r.order_number]),
  );
};

export const toCsv = (header: string[], rows: (string | number)[][]): string => {
  const esc = (v: string | number) => {
    const s = String(v);
    // guard against spreadsheet formula injection from user-controlled text
    const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
};

const hasPayoutDetails = (s: { payout_method: string | null; mpesa_phone: string | null; bank_account_number: string | null; bank_name: string | null }) =>
  s.payout_method === 'mpesa' ? !!s.mpesa_phone : !!(s.bank_account_number && s.bank_name);

// ---------------------------------------------------------------------------
// Finance-facing
// ---------------------------------------------------------------------------

const reserve = async (c: PoolClient, payout: { id: string; store_id: string; amount: string }, attempt: number) =>
  postTransaction(c, {
    type: 'payout_reserve',
    referenceType: 'payout',
    referenceId: payout.id,
    idempotencyKey: `payout_reserve:${payout.id}:${attempt}`,
    description: 'Payout created — funds reserved',
    entries: [
      { account: ACCOUNTS.storeAvailable(payout.store_id), direction: 'debit', amount: Number(payout.amount) },
      { account: ACCOUNTS.payoutsClearing, direction: 'credit', amount: Number(payout.amount) },
    ],
  });

const unreserve = async (c: PoolClient, payout: { id: string; store_id: string; amount: string; attempts: number }, why: string) =>
  postTransaction(c, {
    type: 'payout_release',
    referenceType: 'payout',
    referenceId: payout.id,
    idempotencyKey: `payout_release:${payout.id}:${payout.attempts}`,
    description: `Payout ${why} — funds returned`,
    entries: [
      { account: ACCOUNTS.payoutsClearing, direction: 'debit', amount: Number(payout.amount) },
      { account: ACCOUNTS.storeAvailable(payout.store_id), direction: 'credit', amount: Number(payout.amount) },
    ],
  });

/**
 * Builds a draft batch for every eligible store: available balance at or above the minimum, no active
 * hold, payout details present, and matching the schedule (or all schedules when `schedule` is 'all').
 */
export const generateBatch = async (actor: Actor | null, schedule: 'weekly' | 'monthly' | 'all' = 'all') =>
  tx(async (c) => {
    const minimum = await getNumberSetting('payout.minimum_amount', 500);
    const defaultSchedule = await getSetting<string>('payout.default_schedule', 'weekly');

    const stores = (
      await c.query(
        `SELECT st.id AS store_id, s.id AS seller_id, s.payout_method, s.mpesa_phone, s.bank_name,
                s.bank_account_name, s.bank_account_number, s.minimum_payout,
                COALESCE(s.payout_schedule, $1) AS schedule
         FROM stores st JOIN sellers s ON s.id = st.seller_id
         WHERE st.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM balance_holds h WHERE h.store_id = st.id AND h.active)`,
        [defaultSchedule],
      )
    ).rows;

    const batch = (
      await c.query(
        `INSERT INTO payout_batches (label, schedule, created_by) VALUES ($1, $2, $3) RETURNING *`,
        [`${schedule} payout ${new Date().toISOString().slice(0, 10)}`, schedule, actor?.id ?? null],
      )
    ).rows[0];

    let total = 0;
    let count = 0;
    for (const st of stores) {
      if (schedule !== 'all' && st.schedule !== schedule) continue;
      if (!hasPayoutDetails(st)) continue;
      const b = await getStoreBalances(st.store_id, c);
      const payable = round2(b.available);
      if (toCents(payable) < toCents(Math.max(minimum, Number(st.minimum_payout ?? 0)))) continue;

      const destination =
        st.payout_method === 'mpesa'
          ? { phone: st.mpesa_phone }
          : { bank_name: st.bank_name, account_name: st.bank_account_name, account_number: st.bank_account_number };
      const payout = (
        await c.query(
          `INSERT INTO payouts (batch_id, store_id, seller_id, amount, method, destination) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
          [batch.id, st.store_id, st.seller_id, payable, st.payout_method, JSON.stringify(destination)],
        )
      ).rows[0];
      await reserve(c, payout, 0);
      total += payable;
      count += 1;
    }

    if (count === 0) {
      await c.query(`DELETE FROM payout_batches WHERE id = $1`, [batch.id]);
      return { batch: null, count: 0, total: 0 };
    }
    await c.query(`UPDATE payout_batches SET total_amount = $2 WHERE id = $1`, [batch.id, round2(total)]);
    await audit({ actorId: actor?.id, actorRole: actor?.role ?? 'system', action: 'payout.batch_generate', entityType: 'payout_batch', entityId: batch.id, metadata: { count, total } }, c);
    return { batch: { ...batch, total_amount: round2(total) }, count, total: round2(total) };
  });

export const approveBatch = async (batchId: string, actor: Actor) => {
  const approved = await tx(async (c) => {
    const b = (await c.query(`SELECT * FROM payout_batches WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
    if (!b) throw new AppError(404, 'Batch not found.');
    if (b.status !== 'draft') throw new AppError(409, `This batch is already ${b.status}.`);
    await c.query(`UPDATE payout_batches SET status = 'approved', approved_by = $2, approved_at = NOW() WHERE id = $1`, [batchId, actor.id]);
    const rows = await c.query(`UPDATE payouts SET status = 'processing', attempts = attempts + 1, updated_at = NOW() WHERE batch_id = $1 AND status = 'pending' RETURNING id, store_id, amount`, [batchId]);
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'payout.batch_approve', entityType: 'payout_batch', entityId: batchId }, c);
    return rows.rows;
  });
  for (const p of approved) {
    const owner = await pool.query(`SELECT s.user_id FROM stores st JOIN sellers s ON s.id = st.seller_id WHERE st.id = $1`, [p.store_id]);
    await notify({ userId: owner.rows[0].user_id, type: 'payout_processing', title: 'Your payout is being processed', body: `KSh ${Number(p.amount).toLocaleString('en-KE')} is on its way to you.`, link: '/seller/payouts', email: false });
  }
};

export const cancelBatch = async (batchId: string, actor: Actor) =>
  tx(async (c) => {
    const b = (await c.query(`SELECT * FROM payout_batches WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
    if (!b || b.status !== 'draft') throw new AppError(409, 'Only a draft batch can be cancelled.');
    const rows = (await c.query(`UPDATE payouts SET status = 'cancelled', updated_at = NOW() WHERE batch_id = $1 AND status = 'pending' RETURNING id, store_id, amount, attempts`, [batchId])).rows;
    for (const p of rows) await unreserve(c, p, 'cancelled');
    await c.query(`UPDATE payout_batches SET status = 'cancelled' WHERE id = $1`, [batchId]);
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'payout.batch_cancel', entityType: 'payout_batch', entityId: batchId }, c);
  });

export const markPayoutPaid = async (payoutId: string, actor: Actor, reference: string) => {
  const info = await tx(async (c) => {
    const p = (await c.query(`SELECT * FROM payouts WHERE id = $1 FOR UPDATE`, [payoutId])).rows[0];
    if (!p) throw new AppError(404, 'Payout not found.');
    if (p.status !== 'processing') throw new AppError(409, `Only a processing payout can be marked paid (this one is ${p.status}).`);
    await postTransaction(c, {
      type: 'payout_paid', referenceType: 'payout', referenceId: p.id, idempotencyKey: `payout_paid:${p.id}`, createdBy: actor.id,
      description: `Payout paid (${p.method}, ref ${reference})`,
      entries: [
        { account: ACCOUNTS.payoutsClearing, direction: 'debit', amount: Number(p.amount) },
        { account: ACCOUNTS.mpesa, direction: 'credit', amount: Number(p.amount) },
      ],
    });
    await c.query(`UPDATE payouts SET status = 'paid', reference = $2, paid_at = NOW(), updated_at = NOW() WHERE id = $1`, [payoutId, reference]);
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'payout.paid', entityType: 'payout', entityId: payoutId, metadata: { reference, amount: p.amount } }, c);
    const owner = await c.query(`SELECT s.user_id FROM sellers s WHERE s.id = $1`, [p.seller_id]);
    return { userId: owner.rows[0].user_id, amount: p.amount, method: p.method };
  });
  await notify({ userId: info.userId, type: 'payout_paid', title: 'Payout sent', body: `KSh ${Number(info.amount).toLocaleString('en-KE')} was sent via ${info.method === 'mpesa' ? 'M-Pesa' : 'bank transfer'} (ref ${reference}).`, link: '/seller/payouts', sms: `Loom: payout of KSh ${Number(info.amount).toLocaleString('en-KE')} sent (ref ${reference}).` });
};

export const markPayoutFailed = async (payoutId: string, actor: Actor, reason: string) => {
  const info = await tx(async (c) => {
    const p = (await c.query(`SELECT * FROM payouts WHERE id = $1 FOR UPDATE`, [payoutId])).rows[0];
    if (!p || p.status !== 'processing') throw new AppError(409, 'Only a processing payout can be marked failed.');
    await unreserve(c, p, 'failed');
    await c.query(`UPDATE payouts SET status = 'failed', failure_reason = $2, updated_at = NOW() WHERE id = $1`, [payoutId, reason]);
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'payout.failed', entityType: 'payout', entityId: payoutId, metadata: { reason } }, c);
    const owner = await c.query(`SELECT user_id FROM sellers WHERE id = $1`, [p.seller_id]);
    return { userId: owner.rows[0].user_id, amount: p.amount };
  });
  await notify({ userId: info.userId, type: 'payout_failed', title: 'A payout failed', body: `We could not send KSh ${Number(info.amount).toLocaleString('en-KE')}: ${reason}. The money is back in your available balance — check your payout details.`, link: '/seller/payouts' });
};

/** Re-reserves the funds and puts a failed payout back into processing. */
export const retryPayout = async (payoutId: string, actor: Actor) =>
  tx(async (c) => {
    const p = (await c.query(`SELECT * FROM payouts WHERE id = $1 FOR UPDATE`, [payoutId])).rows[0];
    if (!p || p.status !== 'failed') throw new AppError(409, 'Only a failed payout can be retried.');
    const hold = await c.query(`SELECT 1 FROM balance_holds WHERE store_id = $1 AND active`, [p.store_id]);
    if (hold.rows.length) throw new AppError(409, 'This vendor’s balance is on hold.');
    const b = await getStoreBalances(p.store_id, c);
    if (toCents(b.available) < toCents(Number(p.amount))) throw new AppError(409, 'The vendor no longer has enough available balance for this payout.');
    const attempts = p.attempts + 1;
    await reserve(c, p, attempts);
    await c.query(`UPDATE payouts SET status = 'processing', attempts = $2, failure_reason = NULL, updated_at = NOW() WHERE id = $1`, [payoutId, attempts]);
    await audit({ actorId: actor.id, actorRole: actor.role, action: 'payout.retry', entityType: 'payout', entityId: payoutId }, c);
  });

export const listBatches = async () =>
  (
    await pool.query(
      `SELECT b.*, (SELECT COUNT(*)::int FROM payouts p WHERE p.batch_id = b.id) AS payout_count,
              (SELECT COUNT(*)::int FROM payouts p WHERE p.batch_id = b.id AND p.status = 'paid') AS paid_count
       FROM payout_batches b ORDER BY b.created_at DESC LIMIT 50`,
    )
  ).rows;

export const listAllPayouts = async (opts: { batchId?: string; status?: string }) =>
  (
    await pool.query(
      `SELECT p.*, st.name AS store_name FROM payouts p JOIN stores st ON st.id = p.store_id
       WHERE ($1::uuid IS NULL OR p.batch_id = $1) AND ($2::text IS NULL OR p.status = $2)
       ORDER BY p.created_at DESC LIMIT 300`,
      [opts.batchId ?? null, opts.status ?? null],
    )
  ).rows;

export const placeHold = async (storeId: string, actor: Actor, reason: string) => {
  try {
    await pool.query(`INSERT INTO balance_holds (store_id, reason, created_by) VALUES ($1,$2,$3)`, [storeId, reason, actor.id]);
  } catch (e: any) {
    if (e.code === '23505') throw new AppError(409, 'This store already has an active hold.');
    throw e;
  }
  await audit({ actorId: actor.id, actorRole: actor.role, action: 'payout.hold', entityType: 'store', entityId: storeId, metadata: { reason } });
  const owner = await pool.query(`SELECT s.user_id FROM stores st JOIN sellers s ON s.id = st.seller_id WHERE st.id = $1`, [storeId]);
  await notify({ userId: owner.rows[0].user_id, type: 'balance_hold', title: 'Your payouts are on hold', body: 'Our team is reviewing your account. Contact support if you have questions.', link: '/seller/payouts' });
};

export const releaseHold = async (storeId: string, actor: Actor) => {
  const res = await pool.query(`UPDATE balance_holds SET active = false, released_by = $2, released_at = NOW() WHERE store_id = $1 AND active RETURNING id`, [storeId, actor.id]);
  if (!res.rows.length) throw new AppError(404, 'No active hold on this store.');
  await audit({ actorId: actor.id, actorRole: actor.role, action: 'payout.hold_release', entityType: 'store', entityId: storeId });
};

export const listHolds = async () =>
  (await pool.query(`SELECT h.*, st.name AS store_name FROM balance_holds h JOIN stores st ON st.id = h.store_id WHERE h.active ORDER BY h.created_at DESC`)).rows;

/** Worker: on the scheduled day, draft a batch for finance to review (never pays automatically). */
export const generateScheduledBatches = async (now = new Date()): Promise<void> => {
  const today = now.toISOString().slice(0, 10);
  const already = await pool.query(`SELECT 1 FROM payout_batches WHERE created_at::date = $1::date AND created_by IS NULL`, [today]);
  if (already.rows.length) return;

  const schedules: ('weekly' | 'monthly')[] = [];
  if (now.getUTCDay() === 1) schedules.push('weekly'); // Mondays
  if (now.getUTCDate() === 1) schedules.push('monthly'); // 1st of the month
  for (const s of schedules) {
    const res = await generateBatch(null, s);
    if (res.batch) {
      await notifyRoles(['finance', 'admin', 'super_admin'], {
        type: 'payout_batch_ready', title: 'A payout batch is ready for approval',
        body: `${res.count} vendors, KSh ${res.total.toLocaleString('en-KE')} (${s}).`, link: '/admin/payouts',
      });
    }
  }
};
