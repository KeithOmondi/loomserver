// src/services/fraud.service.ts
//
// Lightweight, rule-based fraud signals. They never block a customer — they raise flags for the
// admin team to review (Admin → Fraud). Each (entity, signal) is flagged once.
import { pool } from '../config/db';

const flag = async (
  entityType: string,
  entityId: string,
  signal: string,
  severity: 'low' | 'medium' | 'high',
  details: Record<string, unknown>,
) => {
  await pool.query(
    `INSERT INTO fraud_flags (entity_type, entity_id, signal, severity, details)
     VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (entity_type, entity_id, signal) DO NOTHING`,
    [entityType, entityId, signal, severity, JSON.stringify(details)],
  );
};

/** Best-effort checks after an order is created. Errors are swallowed on purpose. */
export const flagOrderSignals = async (userId: string, orderIds: string[]): Promise<void> => {
  try {
    const recent = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM orders
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour' AND payment_status <> 'paid'`,
      [userId],
    );
    if (recent.rows[0].n >= 5) {
      await flag('user', userId, 'many_unpaid_orders', 'medium', { unpaid_last_hour: recent.rows[0].n });
    }

    const first = await pool.query<{ n: number; max_total: string }>(
      `SELECT COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS n, COALESCE(MAX(total), 0) AS max_total
       FROM orders WHERE user_id = $1`,
      [userId],
    );
    for (const id of orderIds) {
      const o = await pool.query<{ total: string }>('SELECT total FROM orders WHERE id = $1', [id]);
      if (first.rows[0].n === 0 && Number(o.rows[0]?.total) >= 100_000) {
        await flag('order', id, 'high_value_first_order', 'medium', { total: o.rows[0].total });
      }
    }
  } catch (err) {
    console.error('[fraud] order signal check failed:', (err as Error).message);
  }
};

/** Run from the worker: customers with repeated approved refunds/returns in 30 days. */
export const flagRefundAbuse = async (): Promise<void> => {
  const rows = await pool.query<{ user_id: string; n: number }>(
    `SELECT user_id, COUNT(*)::int AS n FROM refunds
     WHERE status IN ('approved','processed') AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY user_id HAVING COUNT(*) >= 3`,
  );
  for (const r of rows.rows) {
    await flag('user', r.user_id, 'repeated_refunds', 'high', { refunds_30d: r.n });
  }
};
