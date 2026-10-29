// src/stores/store.service.ts

import {
  StoreProfile,
  CreateStoreInput,
  UpdateStoreInput,
  StoreStatus,
  StoreType,
  StoreCategory,
} from './store.types';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import { getSellerByUserId, checkSellerStatus } from '../seller/seller.service';

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_CURRENCY = 'USD';
const DEFAULT_LANGUAGE = 'en';

// ============================================
// HELPER: Generate Slug
// ============================================

const generateSlug = (name: string): string => {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!slug) {
    slug = 'store-' + Date.now().toString(36);
  }

  return slug;
};

const makeSlugUnique = async (baseSlug: string, excludeId?: string): Promise<string> => {
  let slug = baseSlug;
  let counter = 1;

  while (true) {
    const result = await pool.query(
      `SELECT id FROM stores WHERE slug = $1 AND ($2::UUID IS NULL OR id != $2::UUID) AND deleted_at IS NULL`,
      [slug, excludeId || null]
    );

    if (result.rows.length === 0) {
      break;
    }

    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return slug;
};

// ============================================
// HELPER: Map Database Row to StoreProfile
// ============================================

const mapRowToStoreProfile = (row: any): StoreProfile => {
  return {
    id: row.id,
    seller_id: row.seller_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    tagline: row.tagline,
    logo_url: row.logo_url,
    banner_url: row.banner_url,
    cover_image_url: row.cover_image_url,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    support_hours: row.support_hours,
    location: row.location,
    country: row.country,
    timezone: row.timezone,
    social_links: row.social_links || {},
    type: row.type || 'physical',
    category: row.category || 'other',
    sub_categories: row.sub_categories || [],
    status: row.status || StoreStatus.ACTIVE,
    currency: row.currency || DEFAULT_CURRENCY,
    language: row.language || DEFAULT_LANGUAGE,
    return_policy: row.return_policy,
    shipping_origin: row.shipping_origin,
    // ✅ New lifecycle fields
    is_active: row.is_active ?? true,
    activated_at: row.published_at || row.activated_at,
    // ✅ Admin action fields
    suspended_at: row.suspended_at,
    suspended_by: row.suspended_by,
    suspension_reason: row.suspension_reason,
    closed_at: row.closed_at,
    closed_by: row.closed_by,
    closure_reason: row.closure_reason,
    // ✅ Metrics
    total_products: row.total_products || 0,
    total_orders: row.total_orders || 0,
    total_reviews: row.total_reviews || 0,
    average_rating: row.average_rating || 0,
    view_count: row.view_count || 0,
    // ✅ Audit
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    metadata: row.metadata,
  };
};

// ============================================
// CREATE STORE (Instant Activation)
// ============================================

export const createStore = async (
  sellerId: string,
  input: CreateStoreInput
): Promise<StoreProfile> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. CHECK SELLER STATUS (GATEKEEPER)
    const sellerStatus = await checkSellerStatus(sellerId);

    if (!sellerStatus.can_create_stores) {
      throw new AppError(
        403,
        sellerStatus.block_reason ||
          'Cannot create store. Please complete your seller verification.'
      );
    }

    // 2. Get seller details
    const sellerCheck = await client.query(
      `SELECT id, tier, max_stores_allowed, currency FROM sellers WHERE id = $1`,
      [sellerId]
    );

    if (sellerCheck.rows.length === 0) {
      throw new AppError(404, 'Seller not found.');
    }

    const seller = sellerCheck.rows[0];

    // 3. Check if seller has reached max stores limit
    const storeCountResult = await client.query(
      `SELECT COUNT(*) as count FROM stores WHERE seller_id = $1 AND deleted_at IS NULL`,
      [sellerId]
    );

    const currentStoreCount = parseInt(storeCountResult.rows[0].count);
    if (currentStoreCount >= seller.max_stores_allowed) {
      throw new AppError(
        409,
        `Maximum store limit reached. You can have up to ${seller.max_stores_allowed} stores.`
      );
    }

    // 4. Check if store name is available
    const storeNameCheck = await client.query(
      `SELECT id FROM stores WHERE name = $1 AND deleted_at IS NULL`,
      [input.name]
    );

    if (storeNameCheck.rows.length > 0) {
      throw new AppError(409, 'Store name is already taken.');
    }

    // 5. Generate unique slug
    const baseSlug = generateSlug(input.name);
    const slug = await makeSlugUnique(baseSlug);

    // 6. Prepare values from seller
    const currency = input.currency || seller.currency || DEFAULT_CURRENCY;

    // ✅ 7. Create store as ACTIVE immediately (no moderation)
    const result = await client.query(
      `INSERT INTO stores (
        seller_id,
        name,
        slug,
        description,
        tagline,
        logo_url,
        banner_url,
        cover_image_url,
        contact_email,
        contact_phone,
        support_hours,
        location,
        country,
        timezone,
        social_links,
        type,
        category,
        sub_categories,
        status,
        currency,
        language,
        return_policy,
        shipping_origin,
        is_active,
        published_at,
        metadata,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, NOW(), $25, NOW(), NOW()
      )
      RETURNING *`,
      [
        sellerId,
        input.name,
        slug,
        input.description || null,
        input.tagline || null,
        input.logo_url || null,
        input.banner_url || null,
        input.cover_image_url || null,
        input.contact_email || null,
        input.contact_phone || null,
        input.support_hours || null,
        input.location || null,
        input.country || null,
        input.timezone || null,
        input.social_links || {},
        input.type || 'physical',
        input.category || 'other',
        input.sub_categories || [],
        StoreStatus.ACTIVE,        // ✅ Live immediately
        currency,
        input.language || DEFAULT_LANGUAGE,
        input.return_policy || null,
        input.shipping_origin || null,
        true,                       // ✅ is_active
        JSON.stringify({
          created_from_ip: null,
          user_agent: null,
        }),
      ]
    );

    await client.query('COMMIT');

    // ✅ NO moderation queue — store is live immediately

    return mapRowToStoreProfile(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// GET STORE BY ID
// ============================================

export const getStoreById = async (storeId: string): Promise<StoreProfile | null> => {
  const result = await pool.query(
    `SELECT * FROM stores WHERE id = $1 AND deleted_at IS NULL`,
    [storeId]
  );

  return result.rows.length > 0 ? mapRowToStoreProfile(result.rows[0]) : null;
};

// ============================================
// GET STORE BY SLUG
// ============================================

export const getStoreBySlug = async (slug: string): Promise<StoreProfile | null> => {
  const result = await pool.query(
    `SELECT * FROM stores WHERE slug = $1 AND deleted_at IS NULL`,
    [slug]
  );

  return result.rows.length > 0 ? mapRowToStoreProfile(result.rows[0]) : null;
};

// ============================================
// GET STORES BY SELLER ID
// ============================================

export const getStoresBySellerId = async (sellerId: string): Promise<StoreProfile[]> => {
  const result = await pool.query(
    `SELECT * FROM stores WHERE seller_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [sellerId]
  );

  return result.rows.map(mapRowToStoreProfile);
};

// ============================================
// GET MY STORES
// ============================================

export const getMyStores = async (userId: string): Promise<StoreProfile[]> => {
  const seller = await getSellerByUserId(userId);
  if (!seller) {
    return [];
  }

  return getStoresBySellerId(seller.id);
};

// ============================================
// GET STORE WITH SELLER INFO (Public)
// ============================================

export const getStoreWithSeller = async (storeId: string) => {
  const result = await pool.query(
    `SELECT 
      st.*,
      jsonb_build_object(
        'id', s.id,
        'legal_business_name', s.business_name,
        'trading_name', s.trading_name,
        'business_type', s.business_type,
        'country', s.country,
        'rating', s.rating,
        'total_reviews', s.total_reviews,
        'total_orders', s.total_orders,
        'total_products', s.total_products,
        'fulfillment_rate', s.fulfillment_rate,
        'response_rate', s.response_rate
      ) as seller
    FROM stores st
    LEFT JOIN sellers s ON s.id = st.seller_id
    WHERE st.id = $1 
      AND st.deleted_at IS NULL 
      AND st.status = $2 
      AND st.is_active = true`,
    [storeId, StoreStatus.ACTIVE]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
};

// ============================================
// UPDATE STORE
// ============================================

export const updateStore = async (
  storeId: string,
  sellerId: string,
  input: UpdateStoreInput
): Promise<StoreProfile> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. CHECK SELLER STATUS (GATEKEEPER)
    const sellerStatus = await checkSellerStatus(sellerId);

    if (!sellerStatus.can_update_stores) {
      throw new AppError(
        403,
        sellerStatus.block_reason ||
          'Cannot update store. Please complete your seller verification.'
      );
    }

    // 2. Get store and verify ownership
    const store = await getStoreById(storeId);
    if (!store) {
      throw new AppError(404, 'Store not found.');
    }

    if (store.seller_id !== sellerId) {
      throw new AppError(403, 'You do not have permission to update this store.');
    }

    // 3. Check if store can be edited
    if (store.status === StoreStatus.SUSPENDED || store.status === StoreStatus.CLOSED) {
      throw new AppError(403, `Cannot update a ${store.status} store.`);
    }

    // 4. Build dynamic update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      tagline: 'tagline',
      logo_url: 'logo_url',
      banner_url: 'banner_url',
      cover_image_url: 'cover_image_url',
      contact_email: 'contact_email',
      contact_phone: 'contact_phone',
      support_hours: 'support_hours',
      location: 'location',
      country: 'country',
      timezone: 'timezone',
      social_links: 'social_links',
      category: 'category',
      sub_categories: 'sub_categories',
      currency: 'currency',
      language: 'language',
      return_policy: 'return_policy',
      shipping_origin: 'shipping_origin',
    };

    for (const [inputField, dbField] of Object.entries(fieldMap)) {
      const value = input[inputField as keyof UpdateStoreInput];
      if (value !== undefined && value !== null) {
        updates.push(`${dbField} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (updates.length === 0) {
      throw new AppError(400, 'No fields to update.');
    }

    // If name is being updated, update slug too
    if (input.name) {
      const baseSlug = generateSlug(input.name);
      const newSlug = await makeSlugUnique(baseSlug, storeId);
      updates.push(`slug = $${paramCount}`);
      values.push(newSlug);
      paramCount++;
    }

    // Add updated_at
    updates.push(`updated_at = NOW()`);

    // 5. Execute update
    const query = `
      UPDATE stores 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;
    values.push(storeId);

    const result = await client.query(query, values);

    await client.query('COMMIT');

    return mapRowToStoreProfile(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// SUSPEND STORE (Admin)
// ============================================

export const suspendStore = async (
  storeId: string,
  adminId: string,
  reason: string,
  notifySeller: boolean = true
): Promise<StoreProfile> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const store = await getStoreById(storeId);
    if (!store) {
      throw new AppError(404, 'Store not found.');
    }

    if (store.status === StoreStatus.SUSPENDED) {
      throw new AppError(409, 'Store is already suspended.');
    }

    if (store.status === StoreStatus.CLOSED) {
      throw new AppError(409, 'Cannot suspend a closed store.');
    }

    const result = await client.query(
      `UPDATE stores 
       SET status = $1,
           is_active = false,
           suspended_at = NOW(),
           suspended_by = $2,
           suspension_reason = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [StoreStatus.SUSPENDED, adminId, reason, storeId]
    );

    await client.query('COMMIT');

    if (notifySeller) {
      // await sendEmailNotification(store.seller_id, 'store_suspended', { store_name: store.name, reason });
    }

    return mapRowToStoreProfile(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// REINSTATE STORE (Admin)
// ============================================

export const reinstateStore = async (
  storeId: string,
  adminId: string,
  reason?: string,
  notifySeller: boolean = true
): Promise<StoreProfile> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const store = await getStoreById(storeId);
    if (!store) {
      throw new AppError(404, 'Store not found.');
    }

    if (store.status !== StoreStatus.SUSPENDED) {
      throw new AppError(409, 'Store is not suspended.');
    }

    // ✅ Reactivate directly (no need to check is_approved)
    const result = await client.query(
      `UPDATE stores 
       SET status = $1,
           is_active = true,
           suspended_at = NULL,
           suspended_by = NULL,
           suspension_reason = NULL,
           updated_at = NOW(),
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{reinstatement_history}',
             COALESCE(metadata->'reinstatement_history', '[]'::jsonb) || $2::jsonb
           )
       WHERE id = $3
       RETURNING *`,
      [
        StoreStatus.ACTIVE,
        JSON.stringify([
          {
            reason: reason || 'Store reinstated',
            reinstated_by: adminId,
            reinstated_at: new Date(),
          },
        ]),
        storeId,
      ]
    );

    await client.query('COMMIT');

    if (notifySeller) {
      // await sendEmailNotification(store.seller_id, 'store_reinstated', { store_name: store.name, reason });
    }

    return mapRowToStoreProfile(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// CLOSE STORE (Seller or Admin)
// ============================================

export const closeStore = async (
  storeId: string,
  closedBy: string,
  reason?: string
): Promise<StoreProfile> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const store = await getStoreById(storeId);
    if (!store) {
      throw new AppError(404, 'Store not found.');
    }

    if (store.status === StoreStatus.CLOSED) {
      throw new AppError(409, 'Store is already closed.');
    }

    const result = await client.query(
      `UPDATE stores 
       SET status = $1,
           is_active = false,
           closed_at = NOW(),
           closed_by = $2,
           closure_reason = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [StoreStatus.CLOSED, closedBy, reason || null, storeId]
    );

    await client.query('COMMIT');

    return mapRowToStoreProfile(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// DELETE STORE (Soft Delete)
// ============================================

export const deleteStore = async (storeId: string, sellerId: string): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const store = await getStoreById(storeId);
    if (!store) {
      throw new AppError(404, 'Store not found.');
    }

    if (store.seller_id !== sellerId) {
      throw new AppError(403, 'You do not have permission to delete this store.');
    }

    if (store.status === StoreStatus.ACTIVE) {
      throw new AppError(409, 'Cannot delete an active store. Please close it first.');
    }

    await client.query(
      `UPDATE stores SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [storeId]
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
// GET STORES (With Enhanced Filtering)
// ============================================

export interface GetStoresParams {
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'created_at' | 'total_products' | 'total_orders' | 'average_rating';
  sortOrder?: 'asc' | 'desc';
  status?: StoreStatus[];
  category?: StoreCategory[];
  type?: StoreType[];
  seller_id?: string;
  is_active?: boolean;
  has_products?: boolean;
  min_rating?: number;
  max_rating?: number;
  country?: string[];
  date_from?: Date;
  date_to?: Date;
  search?: string;
}

export const getStores = async (params: GetStoresParams) => {
  const {
    page = 1,
    limit = 20,
    sortBy = 'created_at',
    sortOrder = 'desc',
    status,
    category,
    type,
    seller_id,
    is_active,
    has_products,
    min_rating,
    max_rating,
    country,
    date_from,
    date_to,
    search,
  } = params;

  const offset = (page - 1) * limit;
  const conditions: string[] = ['deleted_at IS NULL'];
  const values: any[] = [];
  let paramCount = 1;

  if (status && status.length > 0) {
    conditions.push(`status = ANY($${paramCount})`);
    values.push(status);
    paramCount++;
  }

  if (category && category.length > 0) {
    conditions.push(`category = ANY($${paramCount})`);
    values.push(category);
    paramCount++;
  }

  if (type && type.length > 0) {
    conditions.push(`type = ANY($${paramCount})`);
    values.push(type);
    paramCount++;
  }

  if (seller_id) {
    conditions.push(`seller_id = $${paramCount}`);
    values.push(seller_id);
    paramCount++;
  }

  if (is_active !== undefined) {
    conditions.push(`is_active = $${paramCount}`);
    values.push(is_active);
    paramCount++;
  }

  if (has_products !== undefined) {
    if (has_products) {
      conditions.push(`total_products > 0`);
    } else {
      conditions.push(`total_products = 0`);
    }
  }

  if (min_rating !== undefined) {
    conditions.push(`average_rating >= $${paramCount}`);
    values.push(min_rating);
    paramCount++;
  }

  if (max_rating !== undefined) {
    conditions.push(`average_rating <= $${paramCount}`);
    values.push(max_rating);
    paramCount++;
  }

  if (country && country.length > 0) {
    conditions.push(`country = ANY($${paramCount})`);
    values.push(country);
    paramCount++;
  }

  if (date_from) {
    conditions.push(`created_at >= $${paramCount}`);
    values.push(date_from);
    paramCount++;
  }

  if (date_to) {
    conditions.push(`created_at <= $${paramCount}`);
    values.push(date_to);
    paramCount++;
  }

  if (search) {
    conditions.push(`(
      name ILIKE $${paramCount} OR 
      description ILIKE $${paramCount} OR 
      tagline ILIKE $${paramCount}
    )`);
    values.push(`%${search}%`);
    paramCount++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countQuery = `SELECT COUNT(*) FROM stores ${whereClause}`;
  const countResult = await pool.query(countQuery, values);
  const total = parseInt(countResult.rows[0].count);

  const query = `
    SELECT * FROM stores 
    ${whereClause}
    ORDER BY ${sortBy} ${sortOrder}
    LIMIT $${paramCount} OFFSET $${paramCount + 1}
  `;
  values.push(limit, offset);

  const result = await pool.query(query, values);

  return {
    stores: result.rows.map(mapRowToStoreProfile),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

// ============================================
// CHECK STORE STATUS (Gatekeeper)
// ============================================

export const checkStoreStatus = async (storeId: string): Promise<{
  id: string;
  status: StoreStatus;
  is_live: boolean;
  can_edit: boolean;
  can_add_products: boolean;
  can_process_orders: boolean;
  block_reason?: string;
  actions_required?: string[];
}> => {
  const store = await getStoreById(storeId);
  if (!store) {
    throw new AppError(404, 'Store not found.');
  }

  const isLive = store.status === StoreStatus.ACTIVE && store.is_active === true;
  const canEdit = store.status === StoreStatus.ACTIVE;
  const canAddProducts = store.status === StoreStatus.ACTIVE && store.is_active === true;
  const canProcessOrders = store.status === StoreStatus.ACTIVE && store.is_active === true;

  let blockReason: string | undefined;
  let actionsRequired: string[] = [];

  if (store.status === StoreStatus.SUSPENDED) {
    blockReason = store.suspension_reason || 'Store is suspended.';
    actionsRequired = ['contact_support'];
  } else if (store.status === StoreStatus.CLOSED) {
    blockReason = store.closure_reason || 'Store is closed.';
    actionsRequired = ['contact_support'];
  }

  return {
    id: store.id,
    status: store.status,
    is_live: isLive,
    can_edit: canEdit,
    can_add_products: canAddProducts,
    can_process_orders: canProcessOrders,
    block_reason: blockReason,
    actions_required: actionsRequired.length > 0 ? actionsRequired : undefined,
  };
};

// ============================================
// CHECK IF STORE EXISTS
// ============================================

export const storeExists = async (storeId: string): Promise<boolean> => {
  const result = await pool.query(
    `SELECT id FROM stores WHERE id = $1 AND deleted_at IS NULL`,
    [storeId]
  );
  return result.rows.length > 0;
};

// ============================================
// CHECK IF STORE SLUG EXISTS
// ============================================

export const storeSlugExists = async (slug: string, excludeId?: string): Promise<boolean> => {
  const result = await pool.query(
    `SELECT id FROM stores WHERE slug = $1 AND deleted_at IS NULL AND ($2::UUID IS NULL OR id != $2::UUID)`,
    [slug, excludeId || null]
  );
  return result.rows.length > 0;
};