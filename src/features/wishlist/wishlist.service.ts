// src/features/wishlist/wishlist.service.ts

import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import type {
  ListWishlistQuery,
} from './wishlist.validator';
import { Wishlist, WishlistRow } from './wishlist.types';

// ============================================
// HELPERS
// ============================================

/**
 * Turn `{ page, limit, sort }` into ORDER BY + LIMIT/OFFSET fragments.
 * Sort is whitelisted here — never interpolate user input directly.
 */
const buildSort = (sort: ListWishlistQuery['sort']): string => {
  switch (sort) {
    case 'oldest':
      return 'w.created_at ASC';
    case 'price_asc':
      return 'p.price ASC, w.created_at DESC';
    case 'price_desc':
      return 'p.price DESC, w.created_at DESC';
    case 'newest':
    default:
      return 'w.created_at DESC';
  }
};

// ============================================
// READ — list wishlist
// ============================================

/**
 * Fetch the user's wishlist with pagination, joined with product details
 * and the primary image.
 */
export const getWishlist = async (
  userId: string,
  query: ListWishlistQuery,
): Promise<Wishlist> => {
  const page = Number(query?.page) || 1;
  const limit = Number(query?.limit) || 40;
  const sort = query?.sort ?? 'newest';

  const offset = (page - 1) * limit;
  const orderBy = buildSort(sort);

  const result = await pool.query<{
    id: string;
    product_id: string;
    created_at: Date;
    // product fields
    p_id: string;
    p_name: string;
    p_slug: string;
    p_price: string;
    p_compare_at_price: string | null;
    p_status: string;
    p_is_active: boolean;
    p_stock_quantity: number;
    p_stock_status: string;
    // image fields
    img_id: string | null;
    img_product_id: string | null;
    img_url: string | null;
    img_public_id: string | null;
    img_alt_text: string | null;
    img_is_primary: boolean | null;
    img_sort_order: number | null;
    img_metadata: Record<string, unknown> | null;
    img_created_at: Date | null;
  }>(
    `SELECT
       w.id,
       w.product_id,
       w.created_at,

       p.id                  AS p_id,
       p.name                AS p_name,
       p.slug                AS p_slug,
       p.price               AS p_price,
       p.compare_at_price    AS p_compare_at_price,
       p.status              AS p_status,
       p.is_active           AS p_is_active,
       p.stock_quantity      AS p_stock_quantity,
       p.stock_status        AS p_stock_status,

       img.id                AS img_id,
       img.product_id        AS img_product_id,
       img.url               AS img_url,
       img.public_id         AS img_public_id,
       img.alt_text          AS img_alt_text,
       img.is_primary        AS img_is_primary,
       img.sort_order        AS img_sort_order,
       img.metadata          AS img_metadata,
       img.created_at        AS img_created_at
     FROM wishlists w
     JOIN products p ON p.id = w.product_id
     LEFT JOIN LATERAL (
       SELECT *
       FROM product_images
       WHERE product_id = p.id
       ORDER BY is_primary DESC, sort_order ASC, created_at ASC
       LIMIT 1
     ) img ON TRUE
     WHERE w.user_id = $1
       AND p.deleted_at IS NULL
     ORDER BY ${orderBy}
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );

  const items: WishlistRow[] = result.rows.map((row) => ({
    id: row.id,
    product: {
      id: row.p_id,
      name: row.p_name,
      slug: row.p_slug,
      price: Number(row.p_price),
      compare_at_price:
        row.p_compare_at_price !== null
          ? Number(row.p_compare_at_price)
          : null,
      status: row.p_status as any,
      is_active: row.p_is_active,
      stock_quantity: row.p_stock_quantity,
      stock_status: row.p_stock_status,
      image: row.img_id
        ? {
            id: row.img_id,
            product_id: row.img_product_id as string,
            url: row.img_url as string,
            public_id: row.img_public_id as string,
            alt_text: row.img_alt_text,
            is_primary: row.img_is_primary as boolean,
            sort_order: row.img_sort_order as number,
            metadata: row.img_metadata,
            created_at: row.img_created_at as Date,
          }
        : null,
    },
    saved_at: row.created_at,
  }));

  // Total count for pagination
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM wishlists w
     JOIN products p ON p.id = w.product_id
     WHERE w.user_id = $1
       AND p.deleted_at IS NULL`,
    [userId],
  );
  const itemCount = parseInt(countResult.rows[0]?.count ?? '0', 10);

  return {
    items,
    item_count: itemCount,
  };
};

// ============================================
// WRITE — add to wishlist (idempotent)
// ============================================

/**
 * Add a product to the user's wishlist. If it's already saved, this
 * is a no-op — re-tapping the heart should never error.
 *
 * Returns true if the item was newly inserted, false if it was
 * already there (useful for accurate toast messages).
 */
export const addToWishlist = async (
  userId: string,
  productId: string,
): Promise<{ added: boolean }> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify the product exists and is visible to buyers
    const productResult = await client.query<{
      id: string;
      is_active: boolean;
      status: string;
    }>(
      `SELECT id, is_active, status
       FROM products
       WHERE id = $1 AND deleted_at IS NULL`,
      [productId],
    );
    if (productResult.rows.length === 0) {
      throw new AppError(404, 'Product not found.');
    }

    const product = productResult.rows[0];
    if (!product.is_active || product.status !== 'active') {
      throw new AppError(
        409,
        'Product is not available for wishlist.',
      );
    }

    // Upsert — the UNIQUE (user_id, product_id) constraint handles dedup.
    // `ON CONFLICT DO NOTHING` returns rowCount 0 when the row existed.
    const insertResult = await client.query(
      `INSERT INTO wishlists (user_id, product_id, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [userId, productId],
    );

    await client.query('COMMIT');

    return { added: (insertResult.rowCount ?? 0) > 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// WRITE — remove from wishlist
// ============================================

/**
 * Remove a product from the user's wishlist. Idempotent — removing
 * something that isn't there is not an error.
 */
export const removeFromWishlist = async (
  userId: string,
  productId: string,
): Promise<{ removed: boolean }> => {
  const result = await pool.query(
    `DELETE FROM wishlists
     WHERE user_id = $1 AND product_id = $2`,
    [userId, productId],
  );

  return { removed: (result.rowCount ?? 0) > 0 };
};

// ============================================
// READ — is a product wishlisted?
// ============================================

/**
 * Cheap existence check used by the heart button on product cards and
 * product detail. Returns a plain boolean.
 */
export const isWishlisted = async (
  userId: string,
  productId: string,
): Promise<boolean> => {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM wishlists
       WHERE user_id = $1 AND product_id = $2
     ) AS exists`,
    [userId, productId],
  );
  return result.rows[0]?.exists === true;
};

// ============================================
// WRITE — clear the entire wishlist
// ============================================

/**
 * Remove every item from the user's wishlist. Keeps the user's account
 * intact, only nukes wishlist rows.
 */
export const clearWishlist = async (userId: string): Promise<void> => {
  await pool.query(`DELETE FROM wishlists WHERE user_id = $1`, [userId]);
};

// ============================================
// READ — batch is-wishlisted (for grid badges)
// ============================================

/**
 * Given a list of product ids, return the subset that is wishlisted
 * by this user. Used to render filled/empty hearts on a grid without
 * N separate requests.
 *
 * Returns an object map `{ [productId]: true }` for O(1) lookups.
 */
export const getWishlistedProductIds = async (
  userId: string,
  productIds: string[],
): Promise<Record<string, true>> => {
  if (productIds.length === 0) return {};

  const result = await pool.query<{ product_id: string }>(
    `SELECT product_id
     FROM wishlists
     WHERE user_id = $1
       AND product_id = ANY($2::uuid[])`,
    [userId, productIds],
  );

  const map: Record<string, true> = {};
  for (const row of result.rows) {
    map[row.product_id] = true;
  }
  return map;
};