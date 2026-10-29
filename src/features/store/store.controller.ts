// src/stores/store.controller.ts

import { Request, Response } from 'express';
import {
  createStore,
  getStoreById,
  getStoreBySlug,
  getMyStores,
  updateStore,
  deleteStore,
  getStores,
  getStoreWithSeller,
  suspendStore,
  reinstateStore,
  closeStore,
  checkStoreStatus,
  storeExists,
} from './store.service';
import { CreateStoreInput, UpdateStoreInput, StoreStatus } from './store.types';
import { AppError } from '../../utils/response';
import { asyncHandler } from '../../utils/asyncHandler';
import { pool } from '../../config/db';
import { requireModerator } from '../../middlewares/auth.middleware';
import { getSellerByUserId } from '../seller/seller.service';

// ============================================
// HELPER: Extract String from Params
// ============================================

const extractString = (param: string | string[] | undefined): string => {
  if (!param) {
    throw new AppError(400, 'Parameter is required');
  }
  if (Array.isArray(param)) {
    return param[0];
  }
  return param;
};

// ============================================
// HELPER: Log Admin Action
// ============================================

const logAdminAction = async (data: {
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  notes?: string;
}) => {
  await pool.query(
    `INSERT INTO moderation_history (
      moderator_id,
      action,
      target_type,
      target_id,
      notes,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [data.adminId, data.action, data.targetType, data.targetId, data.notes || null]
  );
};

// ============================================
// CREATE STORE (Instant Activation)
// ============================================

export const createStoreHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError(401, 'Authentication required.');
  }

  if (req.user.role !== 'seller') {
    throw new AppError(403, 'Only sellers can create stores.');
  }

  // Resolve seller profile from user ID
  const seller = await getSellerByUserId(req.user.id);
  if (!seller) {
    throw new AppError(404, 'Seller profile not found. Please complete seller onboarding first.');
  }

  const input = req.body as CreateStoreInput;

  const requiredFields = ['name', 'category', 'type'];
  for (const field of requiredFields) {
    if (!input[field as keyof CreateStoreInput]) {
      throw new AppError(400, `Missing required field: ${field}`);
    }
  }

  const store = await createStore(seller.id, input);

  // ✅ Store is LIVE immediately — no approval needed
  res.status(201).json({
    success: true,
    message: 'Store created successfully! You can now start adding products.',
    data: {
      store,
      nextSteps: [
        'Add products to your store',
        'Set up shipping methods',
        'Configure payment methods',
        'Start selling!',
      ],
    },
  });
});

// ============================================
// GET MY STORES
// ============================================

export const getMyStoresHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError(401, 'Authentication required.');
  }

  const stores = await getMyStores(req.user.id);

  const storesWithStatus = await Promise.all(
    stores.map(async (store) => {
      const status = await checkStoreStatus(store.id);
      return { ...store, status };
    })
  );

  res.status(200).json({
    success: true,
    data: storesWithStatus,
  });
});

// ============================================
// GET STORE BY ID (Public)
// ============================================

export const getStoreHandler = asyncHandler(async (req: Request, res: Response) => {
  const storeId = extractString(req.params.storeId);

  const store = await getStoreWithSeller(storeId);

  if (!store) {
    throw new AppError(404, 'Store not found.');
  }

  res.status(200).json({
    success: true,
    data: store,
  });
});

// ============================================
// GET STORE BY SLUG (Public)
// ============================================

export const getStoreBySlugHandler = asyncHandler(async (req: Request, res: Response) => {
  const slug = extractString(req.params.slug);

  const store = await getStoreWithSellerBySlug(slug);

  if (!store) {
    throw new AppError(404, 'Store not found.');
  }

  res.status(200).json({
    success: true,
    data: store,
  });
});

// ============================================
// UPDATE STORE
// ============================================

export const updateStoreHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError(401, 'Authentication required.');
  }

  const storeId = extractString(req.params.storeId);
  const input = req.body as UpdateStoreInput;

  const exists = await storeExists(storeId);
  if (!exists) {
    throw new AppError(404, 'Store not found.');
  }

  const seller = await getSellerByUserId(req.user.id);
  if (!seller) {
    throw new AppError(404, 'Seller profile not found.');
  }

  const store = await updateStore(storeId, seller.id, input);

  res.status(200).json({
    success: true,
    message: 'Store updated successfully.',
    data: store,
  });
});

// ============================================
// DELETE STORE
// ============================================

export const deleteStoreHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError(401, 'Authentication required.');
  }

  const storeId = extractString(req.params.storeId);

  const seller = await getSellerByUserId(req.user.id);
  if (!seller) {
    throw new AppError(404, 'Seller profile not found.');
  }

  await deleteStore(storeId, seller.id);

  res.status(200).json({
    success: true,
    message: 'Store deleted successfully.',
  });
});

// ============================================
// GET STORE STATUS (Gatekeeper)
// ============================================

export const getStoreStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError(401, 'Authentication required.');
  }

  const storeId = extractString(req.params.storeId);

  const store = await getStoreById(storeId);
  if (!store) {
    throw new AppError(404, 'Store not found.');
  }

  const seller = await getSellerByUserId(req.user.id);
  if (!seller || store.seller_id !== seller.id) {
    throw new AppError(403, 'You do not have access to this store.');
  }

  const status = await checkStoreStatus(storeId);

  res.status(200).json({
    success: true,
    data: status,
  });
});

// ============================================
// CLOSE STORE (Seller)
// ============================================

export const closeStoreHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw new AppError(401, 'Authentication required.');
  }

  const storeId = extractString(req.params.storeId);
  const { reason } = req.body;

  const store = await getStoreById(storeId);
  if (!store) {
    throw new AppError(404, 'Store not found.');
  }

  const seller = await getSellerByUserId(req.user.id);
  if (!seller || store.seller_id !== seller.id) {
    throw new AppError(403, 'You do not have permission to close this store.');
  }

  const closedStore = await closeStore(storeId, req.user.id, reason);

  res.status(200).json({
    success: true,
    message: 'Store closed successfully.',
    data: closedStore,
  });
});

// ============================================
// ADMIN: GET ALL STORES
// ============================================

export const getAllStores = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin')) {
    throw new AppError(403, 'Admin access required.');
  }

  const result = await getStores(req.query);

  res.status(200).json({
    success: true,
    data: result.stores,
    pagination: result.pagination,
  });
});

// ============================================
// ADMIN: SUSPEND STORE
// ============================================

export const suspendStoreHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin')) {
    throw new AppError(403, 'Admin access required.');
  }

  const storeId = extractString(req.params.storeId);
  const { reason, notify_seller = true } = req.body;

  if (!reason) {
    throw new AppError(400, 'Suspension reason is required.');
  }

  const store = await suspendStore(storeId, req.user.id, reason, notify_seller);

  await logAdminAction({
    adminId: req.user.id,
    action: 'store_suspended',
    targetType: 'store',
    targetId: storeId,
    notes: reason,
  });

  res.status(200).json({
    success: true,
    message: 'Store suspended successfully.',
    data: store,
  });
});

// ============================================
// ADMIN: REINSTATE STORE
// ============================================

export const reinstateStoreHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin')) {
    throw new AppError(403, 'Admin access required.');
  }

  const storeId = extractString(req.params.storeId);
  const { reason, notify_seller = true } = req.body;

  const store = await reinstateStore(storeId, req.user.id, reason, notify_seller);

  await logAdminAction({
    adminId: req.user.id,
    action: 'store_reinstated',
    targetType: 'store',
    targetId: storeId,
    notes: reason,
  });

  res.status(200).json({
    success: true,
    message: 'Store reinstated successfully.',
    data: store,
  });
});

// ============================================
// ADMIN: CLOSE STORE
// ============================================

export const adminCloseStoreHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin')) {
    throw new AppError(403, 'Admin access required.');
  }

  const storeId = extractString(req.params.storeId);
  const { reason } = req.body;

  const closedStore = await closeStore(storeId, req.user.id, reason);

  await logAdminAction({
    adminId: req.user.id,
    action: 'store_closed',
    targetType: 'store',
    targetId: storeId,
    notes: reason,
  });

  res.status(200).json({
    success: true,
    message: 'Store closed successfully.',
    data: closedStore,
  });
});

// ============================================
// ADMIN: STORE STATS
// ============================================

export const getStoreStatsAdmin = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin')) {
    throw new AppError(403, 'Admin access required.');
  }

  const result = await pool.query(
    `SELECT 
      COUNT(*) as total_stores,
      COUNT(CASE WHEN status = 'active' AND deleted_at IS NULL THEN 1 END) as active_count,
      COUNT(CASE WHEN status = 'suspended' AND deleted_at IS NULL THEN 1 END) as suspended_count,
      COUNT(CASE WHEN status = 'closed' AND deleted_at IS NULL THEN 1 END) as closed_count,
      COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) as deleted_count,
      COUNT(DISTINCT seller_id) as total_sellers_with_stores,
      COALESCE(SUM(total_products), 0) as total_products,
      COALESCE(SUM(total_orders), 0) as total_orders,
      COALESCE(AVG(average_rating), 0) as avg_rating
    FROM stores`
  );

  const categoryResult = await pool.query(
    `SELECT 
      category,
      COUNT(*) as count
    FROM stores 
    WHERE deleted_at IS NULL AND status = 'active'
    GROUP BY category
    ORDER BY count DESC`
  );

  res.status(200).json({
    success: true,
    data: {
      ...result.rows[0],
      category_distribution: categoryResult.rows,
    },
  });
});

// ============================================
// HELPER: Get Store with Seller by Slug
// ============================================

const getStoreWithSellerBySlug = async (slug: string) => {
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
    WHERE st.slug = $1 
      AND st.deleted_at IS NULL 
      AND st.status = $2 
      AND st.is_active = true`,
    [slug, StoreStatus.ACTIVE]
  );

  return result.rows[0] || null;
};