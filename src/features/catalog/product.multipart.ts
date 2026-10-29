// src/features/catalog/product.multipart.ts

/**
 * Multipart body coercion for product create/update.
 *
 * When a request arrives as `multipart/form-data` (because it includes
 * image files), every non-file field is delivered by multer as a string.
 * Zod schemas expect proper types (numbers, booleans, arrays, objects).
 *
 * This middleware runs AFTER `uploadProductImages` (so `req.files` is
 * populated) and BEFORE the zod validator. It:
 *
 *   1. Coerces known scalar string fields to their proper types.
 *   2. JSON-parses known object/array fields.
 *   3. Merges `req.files` into `req.body.images` so the service can
 *      consume them via the same `input.images` shape as JSON requests.
 *
 * Unknown fields are left untouched — Zod's `.strict()` mode will
 * reject them, which is what we want.
 */

import type { NextFunction, Request, Response } from 'express';

// ============================================
// FIELD CLASSIFICATION
// ============================================

/** Fields that should be parsed as JSON. */
const JSON_FIELDS = new Set([
  'tags',
  'attributes',
  'variants',
  'dimensions',
  'seo',
  'metadata',
  'variant_attribute_ids',
]);

/** Fields that should be coerced to boolean. */
const BOOLEAN_FIELDS = new Set([
  'is_taxable',
  'allow_backorders',
  'allow_preorders',
  'requires_shipping',
  'has_variants',
  'is_featured',
  'is_active',
]);

/** Fields that should be coerced to number. */
const NUMBER_FIELDS = new Set([
  'price',
  'compare_at_price',
  'cost_per_item',
  'stock_quantity',
  'low_stock_threshold',
  'weight',
  'digital_file_size',
]);

/** Fields that should be coerced to Date (or left as ISO string for Zod coerce). */
const DATE_FIELDS = new Set([
  'preorder_release_date',
]);

// ============================================
// HELPERS
// ============================================

const coerceBoolean = (raw: unknown): unknown => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return raw;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  // Anything else — let Zod produce the error message.
  return raw;
};

const coerceNumber = (raw: unknown): unknown => {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return raw;
  // Empty string is treated as "not provided"
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
};

const coerceJson = (raw: unknown): unknown => {
  // Already an object (e.g., from JSON request that hit this middleware by mistake)
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  // Multer only ever sends strings, but the client may have JSON.stringify()'d
  // a null or an empty array — attempt to parse, fall back to raw.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Not valid JSON — return as-is so Zod produces a clear error.
    return raw;
  }
};

/**
 * Normalize `req.body` in place. Also attaches uploaded files under
 * `req.body.images` so the service sees a uniform shape regardless of
 * whether the request was JSON or multipart.
 */
export const parseProductMultipart = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  // Only kick in for multipart requests. JSON requests have already-
  // correct types and shouldn't be touched.
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return next();
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  for (const [key, value] of Object.entries(body)) {
    // Skip File objects that multer may have placed directly on body
    // (shouldn't happen with `.array()`, but be defensive)
    if (
      value &&
      typeof value === 'object' &&
      'buffer' in value &&
      'mimetype' in value
    ) {
      continue;
    }

    // Only coerce single-string values — multer may send arrays for
    // repeated fields, and JSON.parse on those would be wrong.
    if (typeof value !== 'string') continue;

    if (BOOLEAN_FIELDS.has(key)) {
      body[key] = coerceBoolean(value);
      continue;
    }

    if (NUMBER_FIELDS.has(key)) {
      body[key] = coerceNumber(value);
      continue;
    }

    if (JSON_FIELDS.has(key)) {
      body[key] = coerceJson(value);
      continue;
    }

    // Dates: leave as ISO string — the schema uses z.coerce.date()
    // on these fields, which handles strings fine.
    if (DATE_FIELDS.has(key)) {
      continue;
    }

    // Everything else stays as a string — Zod handles trimming, min/max, etc.
  }

  // Drop empty-string values so Zod's `.optional()` fields actually
  // behave as "not provided" rather than "empty string".
  for (const key of Object.keys(body)) {
    if (body[key] === '') {
      delete body[key];
    }
  }

  // Attach uploaded files (if any) as `req.body.images` so the service
  // receives the same shape as a JSON request with pre-parsed images.
  const files = (req as Request & { files?: Express.Multer.File[] }).files;
  if (Array.isArray(files)) {
    (body as Record<string, unknown>).images = files;
  }

  next();
};