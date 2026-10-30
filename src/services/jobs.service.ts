// src/services/jobs.service.ts
//
// Small Postgres-backed job queue (no extra infrastructure). Jobs are claimed with
// FOR UPDATE SKIP LOCKED, so several API instances can run workers safely, and failed jobs
// are retried with exponential backoff.
import type { Pool, PoolClient } from 'pg';
import { pool } from '../config/db';

type Queryable = Pool | PoolClient;
type Handler = (payload: any) => Promise<void>;

const handlers = new Map<string, Handler>();

export const registerHandler = (type: string, fn: Handler): void => {
  handlers.set(type, fn);
};

export const enqueue = async (
  type: string,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {},
  q: Queryable = pool,
): Promise<void> => {
  await q.query(
    `INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1, $2::jsonb, COALESCE($3, NOW()), $4, COALESCE($5, 5))
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [type, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? null],
  );
};

interface JobRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/** Claims and runs up to `limit` due jobs. Returns how many were processed. */
export const runDueJobs = async (limit = 25): Promise<number> => {
  // Re-queue jobs whose worker died mid-run.
  await pool.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL
     WHERE status = 'running' AND locked_at < NOW() - INTERVAL '10 minutes'`,
  );

  const claimed = await pool.query<JobRow>(
    `UPDATE jobs SET status = 'running', locked_at = NOW(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= NOW()
       ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, type, payload, attempts, max_attempts`,
    [limit],
  );

  for (const job of claimed.rows) {
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
      await handler(job.payload);
      await pool.query(`UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL WHERE id = $1`, [job.id]);
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const exhausted = job.attempts >= job.max_attempts;
      await pool.query(
        `UPDATE jobs SET status = $2, locked_at = NULL, last_error = $3,
                run_at = NOW() + ($4 || ' minutes')::interval
         WHERE id = $1`,
        [job.id, exhausted ? 'failed' : 'queued', message, String(Math.pow(2, job.attempts))],
      );
      console.error(`[jobs] ${job.type}#${job.id} attempt ${job.attempts} failed: ${message}`);
    }
  }
  return claimed.rows.length;
};
