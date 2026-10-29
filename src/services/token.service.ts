// src/services/token.service.ts
import { pool } from '../config/db';
import { randomUUID } from 'crypto';

interface RefreshTokenRow {
  id:          string;
  user_id:     string;
  revoked_at:  Date | null;
  replaced_by: string | null;
  expires_at:  Date;
  user_agent:  string | null;
  ip_address:  string | null;
}

export interface SessionSummary {
  id:         string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: Date;
  expires_at: Date;
}

interface TokenMeta {
  userAgent?: string;
  ipAddress?: string;
}

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const createRefreshToken = async (
  userId: string,
  meta?: TokenMeta
): Promise<{ id: string; expiresAt: Date }> => {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, expiresAt, meta?.userAgent ?? null, meta?.ipAddress ?? null]
  );

  return { id, expiresAt };
};

/**
 * rotateRefreshToken — validates an incoming refresh token's DB row and,
 * if valid, revokes it and creates its replacement atomically.
 *
 * Uses SELECT ... FOR UPDATE inside a transaction so two concurrent
 * requests presenting the SAME token cannot both pass the revoked_at
 * check — the second request blocks until the first commits, then
 * correctly sees the row as already revoked (reuse detected).
 *
 * Throws 'REUSE_DETECTED' if the token was already revoked — this is the
 * signal that a stolen/replayed token is being used, since a legitimate
 * client only ever presents each refresh token once.
 *
 * The new row carries forward the ORIGINAL session's user_agent/ip_address
 * rather than whatever the current request reports. This keeps a session's
 * device label stable across rotations — if it took the request's live
 * user-agent/IP instead, a session started on "Chrome on Windows" could
 * silently relabel itself if the same cookie were later refreshed from a
 * different network or client, which would be misleading in a session list.
 */
// A rotated token presented again within this window is treated as a benign race.
const REUSE_GRACE_MS = 15_000;

export const rotateRefreshToken = async (
  tokenId: string,
  userId: string
): Promise<{ id: string; expiresAt: Date }> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query<RefreshTokenRow>(
      `SELECT * FROM refresh_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [tokenId, userId]
    );
    const row = result.rows[0];

    if (!row) {
      await client.query('ROLLBACK');
      throw new Error('TOKEN_NOT_FOUND');
    }

    if (row.revoked_at) {
      await client.query('ROLLBACK');
      // Two refreshes racing (parallel requests, two tabs, two HTTP clients) present the
      // same token within moments. If this token was rotated just now, it's a race, not theft.
      if (row.replaced_by && Date.now() - new Date(row.revoked_at).getTime() < REUSE_GRACE_MS) {
        throw new Error('REFRESH_RACE');
      }
      // Token reuse — someone presented a token that was already rotated.
      // Nuke every active session for this user as a precaution.
      await revokeAllUserTokens(userId);
      throw new Error('REUSE_DETECTED');
    }

    if (row.expires_at < new Date()) {
      await client.query('ROLLBACK');
      throw new Error('TOKEN_EXPIRED');
    }

    const nextId = randomUUID();
    const nextExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    await client.query(
      `INSERT INTO refresh_tokens (id, user_id, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [nextId, userId, nextExpiresAt, row.user_agent, row.ip_address]
    );

    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $1 WHERE id = $2`,
      [nextId, tokenId]
    );

    await client.query('COMMIT');

    return { id: nextId, expiresAt: nextExpiresAt };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const revokeAllUserTokens = async (userId: string): Promise<void> => {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
};

export const deleteExpiredRefreshTokens = async (): Promise<number> => {
  const result = await pool.query(
    `DELETE FROM refresh_tokens WHERE expires_at < now() - interval '30 days'`
  );
  return result.rowCount ?? 0;
};


export const listActiveSessions = async (userId: string): Promise<SessionSummary[]> => {
  const result = await pool.query<SessionSummary>(
    `SELECT id, user_agent, ip_address, created_at, expires_at
     FROM refresh_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
};

// Revokes ONE session by id — scoped to userId too, so a user can never
// revoke a session that isn't theirs just by guessing/enumerating ids.
export const revokeSessionById = async (userId: string, tokenId: string): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tokenId, userId]
  );
  return (result.rowCount ?? 0) > 0;
};