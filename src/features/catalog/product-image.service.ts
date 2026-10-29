// src/features/catalog/product-image.service.ts

import type { PoolClient } from "pg";
import { pool } from "../../config/db";
import { AppError } from "../../utils/response";
import {
  uploadToCloudinary,
  deleteFromCloudinary,
  mediaUrl,
  type StoredAsset,
} from "../../config/cloudinary";

// ============================================
// TYPES
// ============================================

export interface ProductImageRow {
  id: string;
  product_id: string;
  url: string;
  public_id: string;
  alt_text: string | null;
  is_primary: boolean;
  sort_order: number;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface ProductImageDTO {
  id: string;
  product_id: string;
  url: string;
  public_id: string;
  alt_text: string | null;
  is_primary: boolean;
  sort_order: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// ============================================
// HELPERS
// ============================================

const toDTO = (row: ProductImageRow): ProductImageDTO => ({
  id: row.id,
  product_id: row.product_id,
  url: row.url,
  public_id: row.public_id,
  alt_text: row.alt_text,
  is_primary: row.is_primary,
  sort_order: row.sort_order,
  metadata: row.metadata,
  created_at:
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
});

const buildUrl = (asset: StoredAsset): string =>
  mediaUrl(
    {
      publicId: asset.publicId,
      resourceType: asset.resourceType,
      format: asset.format,
    },
    "detail",
  );

// ============================================
// PERSIST
// ============================================

/**
 * Upload files to Cloudinary and insert rows into product_images.
 *
 * Semantics:
 *   - `files === undefined` → leave existing images untouched.
 *   - `files === []`        → delete all existing images.
 *   - `files` with content  → replace all; first is primary.
 */
export const persistProductImages = async (
  client: PoolClient,
  productId: string,
  sellerId: string,
  files: Express.Multer.File[] | undefined,
): Promise<void> => {
  if (files === undefined) return;

  // Fetch existing public_ids so we can clean up Cloudinary
  const existing = await client.query<{ public_id: string }>(
    `SELECT public_id FROM product_images WHERE product_id = $1`,
    [productId],
  );

  // Wipe DB rows
  await client.query(`DELETE FROM product_images WHERE product_id = $1`, [
    productId,
  ]);

  // Best-effort Cloudinary cleanup
  for (const row of existing.rows) {
    try {
      await deleteFromCloudinary(row.public_id, "image");
    } catch (err) {
      console.warn(`[product-image] failed to delete ${row.public_id}:`, err);
    }
  }

  if (files.length === 0) return;

  // Upload all files under a seller-scoped folder
  const folder = `sellers/${sellerId}/products/${productId}`;
  const uploads: StoredAsset[] = [];

  for (const file of files) {
    try {
      const asset = await uploadToCloudinary(file, folder);
      uploads.push(asset);
    } catch (err) {
      // Roll back any uploaded assets for this request
      for (const a of uploads) {
        try {
          await deleteFromCloudinary(a.publicId, "image");
        } catch {
          /* best effort */
        }
      }
      throw new AppError(
        500,
        `Failed to upload product image: ${(err as Error).message}`,
      );
    }
  }

  // Insert rows — first is primary
  for (let i = 0; i < uploads.length; i++) {
    const asset = uploads[i];
    const url = buildUrl(asset);
    await client.query(
      `INSERT INTO product_images
         (product_id, url, public_id, alt_text, is_primary, sort_order, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        productId,
        url,
        asset.publicId,
        null,
        i === 0,
        i,
        JSON.stringify({
          bytes: asset.bytes,
          width: asset.width,
          height: asset.height,
          format: asset.format,
          resource_type: asset.resourceType,
        }),
      ],
    );
  }
};

// ============================================
// READ
// ============================================

export const getProductImages = async (
  productId: string,
  client?: PoolClient,
): Promise<ProductImageDTO[]> => {
  const q = client ?? pool;
  const result = await q.query<ProductImageRow>(
    `SELECT id, product_id, url, public_id, alt_text,
            is_primary, sort_order, metadata, created_at
     FROM product_images
     WHERE product_id = $1
     ORDER BY is_primary DESC, sort_order ASC, created_at ASC`,
    [productId],
  );
  return result.rows.map(toDTO);
};

// ============================================
// DELETE
// ============================================

export const deleteProductImage = async (
  imageId: string,
  sellerId: string,
): Promise<void> => {
  const findResult = await pool.query<{
    id: string;
    product_id: string;
    public_id: string;
    is_primary: boolean;
  }>(
    `SELECT pi.id, pi.product_id, pi.public_id, pi.is_primary
     FROM product_images pi
     JOIN products p ON p.id = pi.product_id
     WHERE pi.id = $1 AND p.seller_id = $2 AND p.deleted_at IS NULL`,
    [imageId, sellerId],
  );

  if (findResult.rows.length === 0) {
    throw new AppError(404, "Image not found or you do not have access.");
  }

  const { product_id, public_id, is_primary } = findResult.rows[0];

  await pool.query(`DELETE FROM product_images WHERE id = $1`, [imageId]);

  // Promote next image if we deleted the primary
  if (is_primary) {
    await pool.query(
      `UPDATE product_images
       SET is_primary = true
       WHERE id = (
         SELECT id FROM product_images
         WHERE product_id = $1
         ORDER BY sort_order ASC, created_at ASC
         LIMIT 1
       )`,
      [product_id],
    );
  }

  try {
    await deleteFromCloudinary(public_id, "image");
  } catch (err) {
    console.warn(`[product-image] failed to delete ${public_id}:`, err);
  }
};

// ============================================
// SET PRIMARY
// ============================================

export const setPrimaryImage = async (
  imageId: string,
  sellerId: string,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const findResult = await client.query<{ product_id: string }>(
      `SELECT pi.product_id
       FROM product_images pi
       JOIN products p ON p.id = pi.product_id
       WHERE pi.id = $1 AND p.seller_id = $2`,
      [imageId, sellerId],
    );

    if (findResult.rows.length === 0) {
      throw new AppError(404, "Image not found or you do not have access.");
    }

    const productId = findResult.rows[0].product_id;

    await client.query(
      `UPDATE product_images SET is_primary = false WHERE product_id = $1`,
      [productId],
    );
    await client.query(
      `UPDATE product_images SET is_primary = true WHERE id = $1`,
      [imageId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};