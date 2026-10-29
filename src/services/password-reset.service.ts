// src/services/password-reset.service.ts
import crypto from 'crypto';
import { pool } from '../config/db';

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour — short-lived by design

const hashToken = (raw: string): string =>
  crypto.createHash('sha256').update(raw).digest('hex');

export const createPasswordResetToken = async (userId: string): Promise<string> => {
  const rawToken = crypto.randomBytes(32).toString('hex'); // 256 bits of entropy
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(rawToken), expiresAt]
  );

  return rawToken; // caller emails this — never persisted in raw form
};

/**
 * consumePasswordResetToken — validates and atomically marks a reset
 * token as used. Returns the associated userId if valid, null otherwise.
 *
 * Uses the same SELECT ... FOR UPDATE transactional pattern as
 * rotateRefreshToken, for the same reason: without the lock, two
 * concurrent requests with the same token could both pass the
 * used_at IS NULL check before either commits, letting a token be
 * consumed twice.
 */
export const consumePasswordResetToken = async (rawToken: string): Promise<string | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query<{
      id: string; user_id: string; expires_at: Date; used_at: Date | null;
    }>(
      `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens
       WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(rawToken)]
    );
    const row = result.rows[0];

    if (!row || row.used_at || row.expires_at < new Date()) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`,
      [row.id]
    );
    await client.query('COMMIT');

    return row.user_id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};