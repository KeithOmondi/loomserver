// src/features/product/product.service.ts

import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import {
  ProductStatus,
  ReviewStatus,
  canTransition,
  deriveStockStatus,
  deriveIsActive,
  deriveIsApproved,
} from './product.types';
import type {
  CreateProductInput,
  UpdateProductInput,
  GetProductsQuery,
  Product,
  ProductMetrics,
  ProductReview,
  ModerateProductInput,
} from './product.types';
import { createModerationItem } from '../moderator/moderator.service';
import {
  ModerationTarget,
  ModerationPriority,
} from '../moderator/moderator.types';

// ✅ Attribute persistence + read helpers
import {
  persistProductAttributes,
  getProductAttributes,
} from '../catalog/product-attribute.service';

// ✅ NEW: image persistence + read helpers
import {
  persistProductImages,
  getProductImages,
} from '../catalog/product-image.service';

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_LIMIT = 20;
const DEFAULT_PRIORITY = ModerationPriority.MEDIUM;

// ============================================
// HELPERS — coercion
// ============================================

const toDateOrNull = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

const toDateRequired = (value: unknown): Date =>
  toDateOrNull(value) ?? new Date();

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const numberRequired = (value: unknown): number => numberOrNull(value) ?? 0;

const boolOr = (value: unknown, fallback = false): boolean =>
  value === null || value === undefined ? fallback : Boolean(value);

// ============================================
// HELPERS — row mapping
// ============================================

const mapRowToProduct = (row: any): Product => ({
  id: row.id,
  store_id: row.store_id,
  seller_id: row.seller_id,

  name: row.name,
  slug: row.slug,
  description: row.description,
  short_description: row.short_description,
  tags: row.tags ?? [],

  type: row.type,
  condition: row.condition ?? 'new',
  visibility: row.visibility ?? 'public',
  category_id: row.category_id,

  price: numberRequired(row.price),
  compare_at_price: numberOrNull(row.compare_at_price),
  cost_per_item: numberOrNull(row.cost_per_item),
  tax_class: row.tax_class,
  is_taxable: boolOr(row.is_taxable, true),

  sku: row.sku,
  barcode: row.barcode,
  stock_quantity: numberRequired(row.stock_quantity),
  stock_status: row.stock_status ?? 'out_of_stock',
  low_stock_threshold: numberRequired(row.low_stock_threshold),
  allow_backorders: boolOr(row.allow_backorders),
  allow_preorders: boolOr(row.allow_preorders),
  preorder_release_date: toDateOrNull(row.preorder_release_date),

  weight: numberOrNull(row.weight),
  weight_unit: row.weight_unit ?? 'kg',
  dimensions: row.dimensions ?? null,
  requires_shipping: boolOr(row.requires_shipping, true),
  shipping_class: row.shipping_class,

  video_url: row.video_url,

  has_variants: boolOr(row.has_variants),
  variant_attribute_ids: row.variant_attribute_ids ?? [],

  digital_file_url: row.digital_file_url,
  digital_file_size: numberOrNull(row.digital_file_size),
  digital_file_name: row.digital_file_name,
  license_key: row.license_key ?? null,

  seo: row.seo ?? {
    meta_title: null,
    meta_description: null,
    meta_keywords: null,
    canonical_url: null,
    og_image_url: null,
  },

  status: row.status,
  is_active: boolOr(row.is_active),
  is_approved: boolOr(row.is_approved),
  is_featured: boolOr(row.is_featured),
  rejection_reason: row.rejection_reason,
  moderated_at: toDateOrNull(row.moderated_at),
  moderated_by: row.moderated_by,
  moderation_notes: row.moderation_notes,

  view_count: numberRequired(row.view_count),
  wishlist_count: numberRequired(row.wishlist_count),
  order_count: numberRequired(row.order_count),
  average_rating: numberRequired(row.average_rating),
  total_reviews: numberRequired(row.total_reviews),
  sales_count: numberRequired(row.sales_count),

  created_at: toDateRequired(row.created_at),
  updated_at: toDateRequired(row.updated_at),
  published_at: toDateOrNull(row.published_at),
  deleted_at: toDateOrNull(row.deleted_at),

  metadata: row.metadata ?? null,
});

const mapRowToReview = (row: any): ProductReview => ({
  id: row.id,
  product_id: row.product_id,
  user_id: row.user_id,
  order_id: row.order_id,
  rating: numberRequired(row.rating),
  title: row.title,
  comment: row.comment,
  images: row.images ?? [],
  is_verified_purchase: boolOr(row.is_verified_purchase),
  is_approved: boolOr(row.is_approved),
  status: row.status,
  helpful_count: numberRequired(row.helpful_count),
  moderated_by: row.moderated_by,
  moderated_at: toDateOrNull(row.moderated_at),
  moderation_reason: row.moderation_reason,
  created_at: toDateRequired(row.created_at),
  updated_at: toDateRequired(row.updated_at),
  deleted_at: toDateOrNull(row.deleted_at),
  user: row.user_name
    ? {
        id: row.user_id,
        full_name: row.user_name,
        avatar_url: row.user_avatar ?? null,
      }
    : undefined,
});

// ============================================
// HELPERS — slug
// ============================================

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);

const makeSlugUnique = async (
  baseSlug: string,
  storeId: string,
  excludeId?: string
): Promise<string> => {
  let slug = baseSlug || 'product';
  let counter = 1;

  while (true) {
    const result = excludeId
      ? await pool.query(
          `SELECT id FROM products
           WHERE slug = $1 AND store_id = $2 AND id <> $3 AND deleted_at IS NULL`,
          [slug, storeId, excludeId]
        )
      : await pool.query(
          `SELECT id FROM products
           WHERE slug = $1 AND store_id = $2 AND deleted_at IS NULL`,
          [slug, storeId]
        );
    if (result.rows.length === 0) break;
    slug = `${baseSlug}-${counter++}`;
  }
  return slug;
};

// ============================================
// CREATE PRODUCT
// ============================================

export const createProduct = async (
  sellerId: string,
  storeId: string,
  input: CreateProductInput,
  submittedByUserId: string
): Promise<Product> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const storeCheck = await client.query(
      `SELECT id FROM stores
       WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL`,
      [storeId, sellerId]
    );
    if (storeCheck.rows.length === 0) {
      throw new AppError(404, 'Store not found or you do not have access.');
    }

    const nameCheck = await client.query(
      `SELECT id FROM products
       WHERE store_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [storeId, input.name]
    );
    if (nameCheck.rows.length > 0) {
      throw new AppError(
        409,
        'A product with this name already exists in your store.'
      );
    }

    const slug = await makeSlugUnique(slugify(input.name), storeId);

    const status = input.status ?? ProductStatus.DRAFT;
    const isActive = deriveIsActive(status);
    const isApproved = deriveIsApproved(status);

    const stockQuantity = input.stock_quantity ?? 0;
    const stockStatus = deriveStockStatus({
      stock_quantity: stockQuantity,
      allow_backorders: input.allow_backorders ?? false,
      allow_preorders: input.allow_preorders ?? false,
      current: input.stock_status,
    });

    const result = await client.query(
      `INSERT INTO products (
        store_id, seller_id, name, slug, description, short_description,
        type, condition, visibility, category_id, tags,
        price, compare_at_price, cost_per_item, tax_class, is_taxable,
        sku, barcode, stock_quantity, stock_status, low_stock_threshold,
        allow_backorders, allow_preorders, preorder_release_date,
        weight, weight_unit, dimensions, requires_shipping, shipping_class,
        video_url, has_variants, variant_attribute_ids,
        digital_file_url, digital_file_size, digital_file_name,
        seo,
        status, is_active, is_approved, is_featured,
        metadata,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21,
        $22, $23, $24,
        $25, $26, $27, $28, $29,
        $30, $31, $32,
        $33, $34, $35,
        $36::jsonb,
        $37, $38, $39, $40,
        $41::jsonb,
        NOW(), NOW()
      ) RETURNING *`,
      [
        storeId,
        sellerId,
        input.name,
        slug,
        input.description ?? null,
        input.short_description ?? null,
        input.type,
        input.condition ?? 'new',
        input.visibility ?? 'public',
        input.category_id ?? null,
        input.tags ?? [],
        input.price,
        input.compare_at_price ?? null,
        input.cost_per_item ?? null,
        input.tax_class ?? null,
        input.is_taxable ?? true,
        input.sku ?? null,
        input.barcode ?? null,
        stockQuantity,
        stockStatus,
        input.low_stock_threshold ?? 5,
        input.allow_backorders ?? false,
        input.allow_preorders ?? false,
        input.preorder_release_date ?? null,
        input.weight ?? null,
        input.weight_unit ?? 'kg',
        input.dimensions ? JSON.stringify(input.dimensions) : null,
        input.requires_shipping ?? true,
        input.shipping_class ?? null,
        input.video_url ?? null,
        input.has_variants ?? false,
        input.variant_attribute_ids ?? [],
        input.digital_file_url ?? null,
        input.digital_file_size ?? null,
        input.digital_file_name ?? null,
        JSON.stringify(input.seo ?? {}),
        status,
        isActive,
        isApproved,
        input.is_featured ?? false,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ]
    );

    const product = mapRowToProduct(result.rows[0]);

    // ✅ Persist attributes inside the same transaction
    await persistProductAttributes(
      client,
      product.id,
      input.category_id ?? null,
      input.attributes
    );

    // ✅ NEW: persist images (upload to Cloudinary, insert rows)
    await persistProductImages(
      client,
      product.id,
      sellerId,
      input.images
    );

    if (status === ProductStatus.PENDING) {
      try {
        await createModerationItem(
          ModerationTarget.PRODUCT,
          product.id,
          submittedByUserId,
          DEFAULT_PRIORITY,
          {
            product_name: product.name,
            product_type: product.type,
            store_id: storeId,
            seller_id: sellerId,
          }
        );
      } catch (e) {
        console.error('Failed to add product to moderation queue:', e);
      }
    }

    await client.query('COMMIT');
    return product;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// GET
// ============================================

export const getProductById = async (
  productId: string,
  includeInactive = false
): Promise<Product | null> => {
  const query = includeInactive
    ? `SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL`
    : `SELECT * FROM products
       WHERE id = $1 AND deleted_at IS NULL AND is_active = true AND status = 'active'`;

  const result = await pool.query(query, [productId]);
  if (result.rows.length === 0) return null;

  const product = mapRowToProduct(result.rows[0]);

  // ✅ Attach attributes
  (product as any).attributes = await getProductAttributes(productId);

  // ✅ NEW: attach images
  (product as any).images = await getProductImages(productId);

  return product;
};

export const getProductBySlug = async (
  slug: string,
  storeId?: string
): Promise<Product | null> => {
  const query = storeId
    ? `SELECT * FROM products
       WHERE slug = $1 AND store_id = $2
         AND deleted_at IS NULL AND is_active = true AND status = 'active'`
    : `SELECT * FROM products
       WHERE slug = $1
         AND deleted_at IS NULL AND is_active = true AND status = 'active'`;

  const params = storeId ? [slug, storeId] : [slug];
  const result = await pool.query(query, params);
  if (result.rows.length === 0) return null;

  const product = mapRowToProduct(result.rows[0]);

  // ✅ Attach attributes
  (product as any).attributes = await getProductAttributes(product.id);

  // ✅ NEW: attach images
  (product as any).images = await getProductImages(product.id);

  return product;
};

// ============================================
// LIST PRODUCTS
// ============================================

export const getProducts = async (
  query: GetProductsQuery,
  sellerId?: string
): Promise<{ products: Product[]; pagination: any; filters: any }> => {
  const {
    page = 1,
    limit = DEFAULT_LIMIT,
    search,
    status,
    type,
    condition,
    category_id,
    store_id,
    seller_id,
    min_price,
    max_price,
    has_variants,
    is_active,
    is_approved,
    is_featured,
    in_stock,
    date_from,
    date_to,
    sort = 'newest',
  } = query;

  const offset = (page - 1) * limit;
  const conditions: string[] = ['deleted_at IS NULL'];
  const values: any[] = [];
  let p = 1;

  if (sellerId) {
    conditions.push(`seller_id = $${p++}`);
    values.push(sellerId);
  }
  if (store_id) {
    conditions.push(`store_id = $${p++}`);
    values.push(store_id);
  }

  // Normalize status to an array
  if (status) {
    const statusArray = Array.isArray(status) ? status : [status];
    if (statusArray.length > 0) {
      conditions.push(`status = ANY($${p++}::text[])`);
      values.push(statusArray);
    }
  }

  if (type) {
    conditions.push(`type = $${p++}`);
    values.push(type);
  }
  if (condition) {
    conditions.push(`condition = $${p++}`);
    values.push(condition);
  }

  // Resolve category_id + all descendant category IDs
  if (category_id) {
    const catResult = await pool.query(
      `WITH RECURSIVE subcats AS (
         SELECT id FROM categories WHERE id = $1
         UNION ALL
         SELECT c.id FROM categories c
         JOIN subcats s ON c.parent_id = s.id
       )
       SELECT id FROM subcats`,
      [category_id]
    );
    const categoryIds = catResult.rows.map((r) => r.id);

    conditions.push(`category_id = ANY($${p++}::uuid[])`);
    values.push(categoryIds);
  }

  if (min_price !== undefined) {
    conditions.push(`price >= $${p++}`);
    values.push(min_price);
  }
  if (max_price !== undefined) {
    conditions.push(`price <= $${p++}`);
    values.push(max_price);
  }
  if (is_active !== undefined) {
    conditions.push(`is_active = $${p++}`);
    values.push(is_active);
  }
  if (is_approved !== undefined) {
    conditions.push(`is_approved = $${p++}`);
    values.push(is_approved);
  }
  if (is_featured !== undefined) {
    conditions.push(`is_featured = $${p++}`);
    values.push(is_featured);
  }
  if (has_variants !== undefined) {
    conditions.push(`has_variants = $${p++}`);
    values.push(has_variants);
  }
  if (in_stock !== undefined) {
    conditions.push(
      in_stock
        ? `stock_quantity > 0 AND stock_status = 'in_stock'`
        : `(stock_quantity = 0 OR stock_status <> 'in_stock')`
    );
  }
  if (date_from) {
    conditions.push(`created_at >= $${p++}`);
    values.push(date_from);
  }
  if (date_to) {
    conditions.push(`created_at <= $${p++}`);
    values.push(date_to);
  }
  if (search) {
    conditions.push(
      `(name ILIKE $${p} OR description ILIKE $${p} OR sku ILIKE $${p})`
    );
    values.push(`%${search}%`);
    p++;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM products ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const sortMap: Record<string, { col: string; dir: 'ASC' | 'DESC' }> = {
    name: { col: 'name', dir: 'ASC' },
    price_asc: { col: 'price', dir: 'ASC' },
    price_desc: { col: 'price', dir: 'DESC' },
    newest: { col: 'created_at', dir: 'DESC' },
    oldest: { col: 'created_at', dir: 'ASC' },
    popular: { col: 'view_count', dir: 'DESC' },
    rating: { col: 'average_rating', dir: 'DESC' },
    sales: { col: 'sales_count', dir: 'DESC' },
    relevance: { col: 'created_at', dir: 'DESC' },
  };
  const { col: sortCol, dir: sortDir } = sortMap[sort] ?? sortMap.newest;

  const listValues = [...values, limit, offset];
  const result = await pool.query(
    `SELECT * FROM products
     ${whereClause}
     ORDER BY ${sortCol} ${sortDir}
     LIMIT $${p} OFFSET $${p + 1}`,
    listValues
  );

  // ✅ FIX: batch-fetch images for all products on this page (avoids N+1)
  const productIds = result.rows.map((r) => r.id);

  const imagesResult = productIds.length
    ? await pool.query(
        `SELECT id, product_id, url, public_id, alt_text,
                is_primary, sort_order, metadata, created_at
         FROM product_images
         WHERE product_id = ANY($1::uuid[])
         ORDER BY is_primary DESC, sort_order ASC, created_at ASC`,
        [productIds]
      )
    : { rows: [] };

  const imagesByProduct: Record<string, any[]> = {};
  imagesResult.rows.forEach((img) => {
    if (!imagesByProduct[img.product_id]) {
      imagesByProduct[img.product_id] = [];
    }
    imagesByProduct[img.product_id].push(img);
  });

  const products = result.rows.map((row) => {
    const product = mapRowToProduct(row);
    (product as any).images = imagesByProduct[row.id] ?? [];
    return product;
  });

  const filterResult = await pool.query(
    `SELECT category_id, status, COUNT(*) AS count
     FROM products ${whereClause}
     GROUP BY category_id, status`,
    values
  );

  const categories: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  filterResult.rows.forEach((row) => {
    if (row.category_id) {
      categories[row.category_id] =
        (categories[row.category_id] ?? 0) + parseInt(row.count, 10);
    }
    if (row.status) {
      statuses[row.status] =
        (statuses[row.status] ?? 0) + parseInt(row.count, 10);
    }
  });

  const priceRangeResult = await pool.query(
    `SELECT MIN(price) AS min, MAX(price) AS max
     FROM products ${whereClause}`,
    values
  );

  return {
    products, // ✅ now includes attached images
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
    filters: {
      categories: Object.entries(categories).map(([id, count]) => ({
        id,
        count,
      })),
      statuses: Object.entries(statuses).map(([status, count]) => ({
        status: status as ProductStatus,
        count,
      })),
      price_range: {
        min: numberRequired(priceRangeResult.rows[0]?.min),
        max: numberRequired(priceRangeResult.rows[0]?.max),
      },
    },
  };
};


// ============================================
// UPDATE PRODUCT (seller)
// ============================================

export const updateProduct = async (
  productId: string,
  sellerId: string,
  input: UpdateProductInput
): Promise<Product> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const productResult = await client.query(
      `SELECT * FROM products
       WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL`,
      [productId, sellerId]
    );
    if (productResult.rows.length === 0) {
      throw new AppError(404, 'Product not found or you do not have access.');
    }

    const existing = productResult.rows[0];

    if (existing.status === ProductStatus.SUSPENDED) {
      throw new AppError(
        409,
        'Cannot update a suspended product. Contact support.'
      );
    }
    if (existing.status === ProductStatus.DISCONTINUED) {
      throw new AppError(409, 'Cannot update a discontinued product.');
    }

    if (input.status !== undefined && input.status !== existing.status) {
      if (!canTransition(existing.status, input.status)) {
        throw new AppError(
          409,
          `Cannot transition product from '${existing.status}' to '${input.status}'.`
        );
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let p = 1;

    const setField = (col: string, value: unknown) => {
      updates.push(`${col} = $${p++}`);
      values.push(value);
    };

    const fieldMap: Record<string, { col: string; json?: boolean }> = {
      name: { col: 'name' },
      slug: { col: 'slug' },
      description: { col: 'description' },
      short_description: { col: 'short_description' },
      type: { col: 'type' },
      condition: { col: 'condition' },
      visibility: { col: 'visibility' },
      category_id: { col: 'category_id' },
      tags: { col: 'tags' },
      price: { col: 'price' },
      compare_at_price: { col: 'compare_at_price' },
      cost_per_item: { col: 'cost_per_item' },
      tax_class: { col: 'tax_class' },
      is_taxable: { col: 'is_taxable' },
      sku: { col: 'sku' },
      barcode: { col: 'barcode' },
      stock_quantity: { col: 'stock_quantity' },
      stock_status: { col: 'stock_status' },
      low_stock_threshold: { col: 'low_stock_threshold' },
      allow_backorders: { col: 'allow_backorders' },
      allow_preorders: { col: 'allow_preorders' },
      preorder_release_date: { col: 'preorder_release_date' },
      weight: { col: 'weight' },
      weight_unit: { col: 'weight_unit' },
      dimensions: { col: 'dimensions', json: true },
      requires_shipping: { col: 'requires_shipping' },
      shipping_class: { col: 'shipping_class' },
      video_url: { col: 'video_url' },
      has_variants: { col: 'has_variants' },
      variants: { col: 'variants', json: true },
      variant_attribute_ids: { col: 'variant_attribute_ids' },
      digital_file_url: { col: 'digital_file_url' },
      digital_file_size: { col: 'digital_file_size' },
      digital_file_name: { col: 'digital_file_name' },
      seo: { col: 'seo', json: true },
      status: { col: 'status' },
      is_featured: { col: 'is_featured' },
      metadata: { col: 'metadata', json: true },
    };

    for (const [inputKey, cfg] of Object.entries(fieldMap)) {
      const value = (input as Record<string, unknown>)[inputKey];
      if (value !== undefined) {
        setField(cfg.col, cfg.json ? JSON.stringify(value) : value);
      }
    }

    if (input.status !== undefined) {
      setField('is_active', deriveIsActive(input.status));
      setField('is_approved', deriveIsApproved(input.status));
    }

    if (input.name !== undefined) {
      const newSlug = await makeSlugUnique(
        slugify(input.name),
        existing.store_id,
        productId
      );
      setField('slug', newSlug);
    }

    if (
      input.stock_quantity !== undefined ||
      input.allow_backorders !== undefined ||
      input.allow_preorders !== undefined ||
      input.stock_status !== undefined
    ) {
      const nextStockStatus = deriveStockStatus({
        stock_quantity: input.stock_quantity ?? existing.stock_quantity,
        allow_backorders:
          input.allow_backorders ?? existing.allow_backorders,
        allow_preorders:
          input.allow_preorders ?? existing.allow_preorders,
        current: input.stock_status ?? existing.stock_status,
      });
      setField('stock_status', nextStockStatus);
    }

    // ✅ Only reject if there are no updates AND nothing to persist
    const hasAttributesUpdate = input.attributes !== undefined;
    const hasImagesUpdate = input.images !== undefined;
    if (
      updates.length === 0 &&
      !hasAttributesUpdate &&
      !hasImagesUpdate
    ) {
      throw new AppError(400, 'No fields to update.');
    }

    let updatedRow = existing;

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      values.push(productId);

      const result = await client.query(
        `UPDATE products SET ${updates.join(', ')}
         WHERE id = $${p}
         RETURNING *`,
        values
      );
      updatedRow = result.rows[0];
    }

    // ✅ Persist attributes (replace semantics)
    await persistProductAttributes(
      client,
      productId,
      (input.category_id ?? existing.category_id) ?? null,
      input.attributes
    );

    // ✅ NEW: persist images (replace semantics)
    await persistProductImages(
      client,
      productId,
      sellerId,
      input.images
    );

    await client.query('COMMIT');
    return mapRowToProduct(updatedRow);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// MODERATE PRODUCT
// ============================================

export const moderateProduct = async (
  productId: string,
  moderatorId: string,
  approved: boolean,
  rejectionReason?: string,
  notes?: string
): Promise<Product> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT id, status FROM products WHERE id = $1 AND deleted_at IS NULL`,
      [productId]
    );
    if (check.rows.length === 0) {
      throw new AppError(404, 'Product not found.');
    }

    const existing = check.rows[0];
    if (existing.status !== ProductStatus.PENDING) {
      throw new AppError(
        409,
        `Product is currently '${existing.status}'. Only 'pending' products can be reviewed.`
      );
    }

    const nextStatus = approved
      ? ProductStatus.ACTIVE
      : ProductStatus.REJECTED;

    if (!canTransition(existing.status, nextStatus)) {
      throw new AppError(
        500,
        `Invalid transition from '${existing.status}' to '${nextStatus}'.`
      );
    }

    const result = await client.query(
      `UPDATE products
       SET status = $1,
           is_active = $2,
           is_approved = $3,
           rejection_reason = $4,
           moderated_at = NOW(),
           moderated_by = $5,
           moderation_notes = $6,
           published_at = CASE
             WHEN $2 = true THEN COALESCE(published_at, NOW())
             ELSE published_at
           END,
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        nextStatus,
        deriveIsActive(nextStatus),
        deriveIsApproved(nextStatus),
        approved ? null : rejectionReason ?? 'Rejected during moderation.',
        moderatorId,
        notes ?? null,
        productId,
      ]
    );

    await client.query('COMMIT');
    return mapRowToProduct(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// DELETE
// ============================================

export const deleteProduct = async (
  productId: string,
  sellerId: string
): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const productResult = await client.query(
      `SELECT id, status FROM products
       WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL`,
      [productId, sellerId]
    );
    if (productResult.rows.length === 0) {
      throw new AppError(404, 'Product not found or you do not have access.');
    }
    if (productResult.rows[0].status === ProductStatus.ACTIVE) {
      throw new AppError(
        409,
        'Cannot delete an active product. Please deactivate it first.'
      );
    }

    await client.query(
      `UPDATE products SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [productId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// REVIEWS
// ============================================

export const createProductReview = async (
  userId: string,
  input: {
    product_id: string;
    order_id?: string;
    rating: number;
    title?: string;
    comment?: string;
    images?: string[];
  }
): Promise<ProductReview> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const productResult = await client.query(
      `SELECT id, seller_id FROM products
       WHERE id = $1 AND is_active = true AND status = 'active' AND deleted_at IS NULL`,
      [input.product_id]
    );
    if (productResult.rows.length === 0) {
      throw new AppError(404, 'Product not found or not available.');
    }

    const existingReview = await client.query(
      `SELECT id FROM product_reviews
       WHERE product_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [input.product_id, userId]
    );
    if (existingReview.rows.length > 0) {
      throw new AppError(409, 'You have already reviewed this product.');
    }

    let isVerifiedPurchase = false;
    if (input.order_id) {
      const orderResult = await client.query(
        `SELECT id FROM orders
         WHERE id = $1 AND user_id = $2 AND status = 'completed'`,
        [input.order_id, userId]
      );
      isVerifiedPurchase = orderResult.rows.length > 0;
    }

    const result = await client.query(
      `INSERT INTO product_reviews (
         product_id, user_id, order_id, rating, title, comment, images,
         is_verified_purchase, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW(), NOW())
       RETURNING *`,
      [
        input.product_id,
        userId,
        input.order_id ?? null,
        input.rating,
        input.title ?? null,
        input.comment ?? null,
        JSON.stringify(input.images ?? []),
        isVerifiedPurchase,
        ReviewStatus.PENDING,
      ]
    );

    try {
      await createModerationItem(
        ModerationTarget.REVIEW,
        result.rows[0].id,
        userId,
        ModerationPriority.LOW,
        { product_id: input.product_id, rating: input.rating }
      );
    } catch (e) {
      console.error('Failed to add review to moderation queue:', e);
    }

    await client.query('COMMIT');
    return mapRowToReview(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getProductReviews = async (
  productId: string,
  page = 1,
  limit = 10,
  onlyApproved = true
): Promise<{ reviews: ProductReview[]; summary: any; pagination: any }> => {
  const offset = (page - 1) * limit;
  const conditions: string[] = ['pr.product_id = $1', 'pr.deleted_at IS NULL'];
  const values: any[] = [productId];
  let p = 2;

  if (onlyApproved) {
    conditions.push(`pr.status = 'approved'`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM product_reviews pr ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const listValues = [...values, limit, offset];
  const result = await pool.query(
    `SELECT pr.*, u.full_name AS user_name, u.avatar_url AS user_avatar
     FROM product_reviews pr
     LEFT JOIN users u ON u.id = pr.user_id
     ${whereClause}
     ORDER BY pr.created_at DESC
     LIMIT $${p} OFFSET $${p + 1}`,
    listValues
  );

  const summaryResult = await pool.query(
    `SELECT
       COALESCE(AVG(rating), 0) AS average_rating,
       COUNT(*) AS total_reviews,
       COUNT(*) FILTER (WHERE rating = 1) AS rating_1,
       COUNT(*) FILTER (WHERE rating = 2) AS rating_2,
       COUNT(*) FILTER (WHERE rating = 3) AS rating_3,
       COUNT(*) FILTER (WHERE rating = 4) AS rating_4,
       COUNT(*) FILTER (WHERE rating = 5) AS rating_5
     FROM product_reviews pr ${whereClause}`,
    values
  );
  const summary = summaryResult.rows[0];

  return {
    reviews: result.rows.map(mapRowToReview),
    summary: {
      average_rating: numberRequired(summary.average_rating),
      total_reviews: parseInt(summary.total_reviews ?? '0', 10),
      rating_distribution: {
        1: parseInt(summary.rating_1 ?? '0', 10),
        2: parseInt(summary.rating_2 ?? '0', 10),
        3: parseInt(summary.rating_3 ?? '0', 10),
        4: parseInt(summary.rating_4 ?? '0', 10),
        5: parseInt(summary.rating_5 ?? '0', 10),
      },
    },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

// ============================================
// METRICS
// ============================================

export const getProductMetrics = async (
  productId: string,
  period: 'today' | 'week' | 'month' | 'year' | 'all' = 'month'
): Promise<ProductMetrics> => {
  const now = new Date();
  let startDate: Date;
  switch (period) {
    case 'today':
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'week':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
      break;
    case 'month':
      startDate = new Date(now);
      startDate.setMonth(now.getMonth() - 1);
      break;
    case 'year':
      startDate = new Date(now);
      startDate.setFullYear(now.getFullYear() - 1);
      break;
    default:
      startDate = new Date(0);
  }

  const result = await pool.query(
    `SELECT
       COALESCE(SUM(pv.count), 0) AS views,
       COALESCE(SUM(w.count), 0) AS wishlist_count,
       COALESCE(SUM(oi.quantity), 0) AS order_count,
       COALESCE(SUM(oi.price * oi.quantity), 0) AS revenue,
       COALESCE(AVG(pr.rating), 0) AS average_rating,
       COUNT(DISTINCT pr.id) AS total_reviews,
       CASE WHEN SUM(pv.count) > 0
            THEN (SUM(oi.quantity)::float / SUM(pv.count) * 100)
            ELSE 0 END AS conversion_rate,
       CASE WHEN SUM(oi.quantity) > 0
            THEN (COUNT(DISTINCT r.id)::float / SUM(oi.quantity) * 100)
            ELSE 0 END AS return_rate
     FROM products p
     LEFT JOIN product_views pv ON pv.product_id = p.id AND pv.created_at >= $2
     LEFT JOIN wishlists w       ON w.product_id = p.id AND w.created_at >= $2
     LEFT JOIN order_items oi    ON oi.product_id = p.id AND oi.created_at >= $2
     LEFT JOIN product_reviews pr ON pr.product_id = p.id AND pr.created_at >= $2
     LEFT JOIN returns r ON r.order_item_id = oi.id AND r.created_at >= $2
     WHERE p.id = $1
     GROUP BY p.id`,
    [productId, startDate]
  );

  if (result.rows.length === 0) {
    throw new AppError(404, 'Product not found or no data available.');
  }

  const row = result.rows[0];
  return {
    product_id: productId,
    period,
    views: numberRequired(row.views),
    wishlist_count: numberRequired(row.wishlist_count),
    order_count: numberRequired(row.order_count),
    revenue: numberRequired(row.revenue),
    average_rating: numberRequired(row.average_rating),
    total_reviews: numberRequired(row.total_reviews),
    conversion_rate: numberRequired(row.conversion_rate),
    return_rate: numberRequired(row.return_rate),
  };
};

// ============================================
// RATING UPDATE
// ============================================

export const updateProductRating = async (
  productId: string
): Promise<void> => {
  const result = await pool.query(
    `SELECT COALESCE(AVG(rating), 0) AS avg_rating,
            COUNT(*) AS total_reviews
     FROM product_reviews
     WHERE product_id = $1 AND status = 'approved' AND deleted_at IS NULL`,
    [productId]
  );
  const { avg_rating, total_reviews } = result.rows[0];

  await pool.query(
    `UPDATE products
     SET average_rating = $1, total_reviews = $2, updated_at = NOW()
     WHERE id = $3`,
    [avg_rating, parseInt(total_reviews, 10), productId]
  );
};

// ============================================
// CHECKS
// ============================================

export const productExists = async (productId: string): Promise<boolean> => {
  const result = await pool.query(
    `SELECT id FROM products WHERE id = $1 AND deleted_at IS NULL`,
    [productId]
  );
  return result.rows.length > 0;
};

export const productSlugExists = async (
  slug: string,
  storeId: string,
  excludeId?: string
): Promise<boolean> => {
  const query = excludeId
    ? `SELECT id FROM products
       WHERE slug = $1 AND store_id = $2 AND id <> $3 AND deleted_at IS NULL`
    : `SELECT id FROM products
       WHERE slug = $1 AND store_id = $2 AND deleted_at IS NULL`;
  const params = excludeId ? [slug, storeId, excludeId] : [slug, storeId];
  const result = await pool.query(query, params);
  return result.rows.length > 0;
};

// ============================================
// ADMIN UPDATE (bypasses seller ownership check)
// ============================================

export const adminUpdateProduct = async (
  productId: string,
  input: UpdateProductInput
): Promise<Product> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingResult = await client.query(
      `SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL`,
      [productId]
    );
    if (existingResult.rows.length === 0) {
      throw new AppError(404, 'Product not found.');
    }

    const existing = existingResult.rows[0];

    if (input.status !== undefined && input.status !== existing.status) {
      if (!canTransition(existing.status, input.status)) {
        throw new AppError(
          409,
          `Cannot transition product from '${existing.status}' to '${input.status}'.`
        );
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let p = 1;

    const setField = (col: string, value: unknown) => {
      updates.push(`${col} = $${p++}`);
      values.push(value);
    };

    const fieldMap: Record<string, { col: string; json?: boolean }> = {
      name: { col: 'name' },
      slug: { col: 'slug' },
      description: { col: 'description' },
      short_description: { col: 'short_description' },
      type: { col: 'type' },
      condition: { col: 'condition' },
      visibility: { col: 'visibility' },
      category_id: { col: 'category_id' },
      tags: { col: 'tags' },
      price: { col: 'price' },
      compare_at_price: { col: 'compare_at_price' },
      cost_per_item: { col: 'cost_per_item' },
      tax_class: { col: 'tax_class' },
      is_taxable: { col: 'is_taxable' },
      sku: { col: 'sku' },
      barcode: { col: 'barcode' },
      stock_quantity: { col: 'stock_quantity' },
      stock_status: { col: 'stock_status' },
      low_stock_threshold: { col: 'low_stock_threshold' },
      allow_backorders: { col: 'allow_backorders' },
      allow_preorders: { col: 'allow_preorders' },
      preorder_release_date: { col: 'preorder_release_date' },
      weight: { col: 'weight' },
      weight_unit: { col: 'weight_unit' },
      dimensions: { col: 'dimensions', json: true },
      requires_shipping: { col: 'requires_shipping' },
      shipping_class: { col: 'shipping_class' },
      video_url: { col: 'video_url' },
      has_variants: { col: 'has_variants' },
      variants: { col: 'variants', json: true },
      variant_attribute_ids: { col: 'variant_attribute_ids' },
      digital_file_url: { col: 'digital_file_url' },
      digital_file_size: { col: 'digital_file_size' },
      digital_file_name: { col: 'digital_file_name' },
      seo: { col: 'seo', json: true },
      status: { col: 'status' },
      is_featured: { col: 'is_featured' },
      is_active: { col: 'is_active' },
      metadata: { col: 'metadata', json: true },
    };

    for (const [inputKey, cfg] of Object.entries(fieldMap)) {
      const value = (input as Record<string, unknown>)[inputKey];
      if (value !== undefined) {
        setField(cfg.col, cfg.json ? JSON.stringify(value) : value);
      }
    }

    if (input.status !== undefined) {
      setField('is_active', deriveIsActive(input.status));
      setField('is_approved', deriveIsApproved(input.status));
    }

    const hasAttributesUpdate = input.attributes !== undefined;
    const hasImagesUpdate = input.images !== undefined;
    if (
      updates.length === 0 &&
      !hasAttributesUpdate &&
      !hasImagesUpdate
    ) {
      throw new AppError(400, 'No fields to update.');
    }

    let updatedRow = existing;

    if (updates.length > 0) {
      updates.push('updated_at = NOW()');
      values.push(productId);

      const result = await client.query(
        `UPDATE products SET ${updates.join(', ')}
         WHERE id = $${p}
         RETURNING *`,
        values
      );
      updatedRow = result.rows[0];
    }

    // ✅ Persist attributes (replace semantics)
    await persistProductAttributes(
      client,
      productId,
      (input.category_id ?? existing.category_id) ?? null,
      input.attributes
    );

    // ✅ NEW: persist images (replace semantics)
    //    Admin path has no seller context — use the product's seller_id
    await persistProductImages(
      client,
      productId,
      existing.seller_id,
      input.images
    );

    await client.query('COMMIT');
    return mapRowToProduct(updatedRow);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};