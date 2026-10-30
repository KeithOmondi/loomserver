// src/services/ledger.service.ts
//
// Double-entry ledger. Every money movement is a transaction of balanced debit/credit entries
// (the database refuses to commit an unbalanced one) and is idempotent via its key, so a
// retried webhook or job can never credit twice. Balances are ALWAYS derived from entries.
import type { Pool, PoolClient } from 'pg';
import { pool } from '../config/db';
import { AppError } from '../utils/response';
import { toCents } from './money';

type Queryable = Pool | PoolClient;

export interface AccountSpec {
  code: string;
  name: string;
  kind: 'asset' | 'liability' | 'revenue' | 'expense';
  ownerType: 'platform' | 'store' | 'customer';
  ownerId?: string;
}

export const ACCOUNTS = {
  /** cash received from / sent to customers & vendors via M-Pesa, not yet banked */
  mpesa: { code: 'platform:mpesa_clearing', name: 'M-Pesa clearing', kind: 'asset', ownerType: 'platform' } as AccountSpec,
  commissionPending: {
    code: 'platform:commission_pending',
    name: 'Commission held in escrow',
    kind: 'liability',
    ownerType: 'platform',
  } as AccountSpec,
  commissionRevenue: {
    code: 'platform:commission_revenue',
    name: 'Commission revenue',
    kind: 'revenue',
    ownerType: 'platform',
  } as AccountSpec,
  /** delivery fees held in escrow until the order is delivered (platform pays couriers from these) */
  deliveryPending: {
    code: 'platform:delivery_pending',
    name: 'Delivery fees held in escrow',
    kind: 'liability',
    ownerType: 'platform',
  } as AccountSpec,
  deliveryRevenue: {
    code: 'platform:delivery_revenue',
    name: 'Delivery fees collected',
    kind: 'revenue',
    ownerType: 'platform',
  } as AccountSpec,
  promoExpense: { code: 'platform:promo_expense', name: 'Platform-funded promotions', kind: 'expense', ownerType: 'platform' } as AccountSpec,
  payoutsClearing: {
    code: 'platform:payouts_clearing',
    name: 'Payouts in transit',
    kind: 'liability',
    ownerType: 'platform',
  } as AccountSpec,
  adjustments: { code: 'platform:adjustments', name: 'Manual adjustments', kind: 'expense', ownerType: 'platform' } as AccountSpec,
  storePending: (storeId: string): AccountSpec => ({
    code: `store:${storeId}:pending`,
    name: 'Vendor earnings in escrow',
    kind: 'liability',
    ownerType: 'store',
    ownerId: storeId,
  }),
  storeAvailable: (storeId: string): AccountSpec => ({
    code: `store:${storeId}:available`,
    name: 'Vendor available balance',
    kind: 'liability',
    ownerType: 'store',
    ownerId: storeId,
  }),
  wallet: (userId: string): AccountSpec => ({
    code: `customer:${userId}:wallet`,
    name: 'Customer store credit',
    kind: 'liability',
    ownerType: 'customer',
    ownerId: userId,
  }),
};

export interface LedgerEntryInput {
  account: AccountSpec;
  direction: 'debit' | 'credit';
  amount: number;
}

export interface LedgerTransactionInput {
  type: string;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
  entries: LedgerEntryInput[];
}

const ensureAccount = async (q: Queryable, spec: AccountSpec): Promise<string> => {
  const res = await q.query<{ id: string }>(
    `INSERT INTO ledger_accounts (code, name, kind, owner_type, owner_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [spec.code, spec.name, spec.kind, spec.ownerType, spec.ownerId ?? null],
  );
  return res.rows[0].id;
};

/**
 * Posts one balanced transaction on the caller's client (so it commits or rolls back with the
 * business change). Returns `duplicate: true` and writes nothing if the key was already used.
 */
export const postTransaction = async (
  client: PoolClient,
  tx: LedgerTransactionInput,
): Promise<{ id: string; duplicate: boolean }> => {
  const entries = tx.entries.filter((e) => toCents(e.amount) > 0);
  if (entries.length < 2) throw new AppError(500, 'A ledger transaction needs at least two entries.');

  const debit = entries.filter((e) => e.direction === 'debit').reduce((s, e) => s + toCents(e.amount), 0);
  const credit = entries.filter((e) => e.direction === 'credit').reduce((s, e) => s + toCents(e.amount), 0);
  if (debit !== credit) {
    throw new AppError(500, `Unbalanced ledger transaction (${tx.type}): debits ${debit / 100} ≠ credits ${credit / 100}.`);
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions
       (type, reference_type, reference_id, idempotency_key, description, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      tx.type,
      tx.referenceType ?? null,
      tx.referenceId ?? null,
      tx.idempotencyKey,
      tx.description ?? null,
      JSON.stringify(tx.metadata ?? {}),
      tx.createdBy ?? null,
    ],
  );

  if (inserted.rows.length === 0) {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM ledger_transactions WHERE idempotency_key = $1',
      [tx.idempotencyKey],
    );
    return { id: existing.rows[0].id, duplicate: true };
  }

  const txId = inserted.rows[0].id;
  for (const e of entries) {
    const accountId = await ensureAccount(client, e.account);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount) VALUES ($1, $2, $3, $4)`,
      [txId, accountId, e.direction, e.amount],
    );
  }
  return { id: txId, duplicate: false };
};

export const getBalance = async (code: string, q: Queryable = pool): Promise<number> => {
  const res = await q.query<{ balance: string }>('SELECT balance FROM ledger_balances WHERE code = $1', [code]);
  return res.rows.length ? Number(res.rows[0].balance) : 0;
};

export interface StoreBalances {
  /** earnings still in escrow (not yet payable) */
  pending: number;
  /** earnings released and payable (can be negative if refunds exceeded it) */
  available: number;
  /** amount reserved by payouts that have been created but not yet settled */
  inPayout: number;
}

export const getStoreBalances = async (storeId: string, q: Queryable = pool): Promise<StoreBalances> => {
  const [pending, available] = await Promise.all([
    getBalance(ACCOUNTS.storePending(storeId).code, q),
    getBalance(ACCOUNTS.storeAvailable(storeId).code, q),
  ]);
  const inFlight = await q.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payouts WHERE store_id = $1 AND status IN ('pending','processing')`,
    [storeId],
  );
  return { pending, available, inPayout: Number(inFlight.rows[0].total) };
};

export const getWalletBalance = (userId: string, q: Queryable = pool) =>
  getBalance(ACCOUNTS.wallet(userId).code, q);

/** Whole-ledger sanity check: debits must equal credits. Used by the admin escrow overview. */
export const verifyLedgerBalanced = async (q: Queryable = pool): Promise<{ balanced: boolean; difference: number }> => {
  const res = await q.query<{ diff: string }>(
    `SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END), 0) AS diff FROM ledger_entries`,
  );
  const diff = Number(res.rows[0].diff);
  return { balanced: diff === 0, difference: diff };
};
