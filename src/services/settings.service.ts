// src/services/settings.service.ts
import { pool } from '../config/db';

const CACHE_MS = 30_000;
const cache = new Map<string, { value: unknown; at: number }>();

export const getSetting = async <T>(key: string, fallback: T): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;

  const res = await pool.query<{ value: T }>('SELECT value FROM platform_settings WHERE key = $1', [key]);
  const value = res.rows.length ? res.rows[0].value : fallback;
  cache.set(key, { value, at: Date.now() });
  return value;
};

export const getNumberSetting = async (key: string, fallback: number): Promise<number> => {
  const v = await getSetting<unknown>(key, fallback);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const listSettings = async () => {
  const res = await pool.query(
    'SELECT key, value, description, updated_at FROM platform_settings ORDER BY key',
  );
  return res.rows;
};

export const setSetting = async (key: string, value: unknown, userId: string): Promise<void> => {
  const res = await pool.query(
    `UPDATE platform_settings SET value = $2::jsonb, updated_by = $3, updated_at = NOW() WHERE key = $1`,
    [key, JSON.stringify(value), userId],
  );
  if (res.rowCount === 0) throw new Error(`Unknown setting: ${key}`);
  cache.delete(key);
};
