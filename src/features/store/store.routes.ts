// src/features/store/store.routes.ts

import { Router } from 'express';
import { protect, requireAdmin } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  createStoreSchema,
  updateStoreSchema,
  getStoresQuerySchema,
  suspendStoreSchema,
  reinstateStoreSchema,
  closeStoreSchema,
  //storeMetricsSchema,
  checkStoreSlugSchema,
} from './store.validator';
import {
  // Seller handlers
  createStoreHandler,
  getMyStoresHandler,
  getStoreHandler,
  getStoreBySlugHandler,
  updateStoreHandler,
  deleteStoreHandler,
  getStoreStatusHandler,
  closeStoreHandler,

  // Admin handlers
  getAllStores,
  suspendStoreHandler,
  reinstateStoreHandler,
  adminCloseStoreHandler,
  getStoreStatsAdmin,
} from './store.controller';

const router = Router();

// ============================================
// PROTECTED ROUTES — STATIC PATHS FIRST
// ============================================

// IMPORTANT: '/my/stores' must be registered before '/:storeId'.
// Otherwise Express matches it as a single path segment and treats "my"
// as a storeId.
router.get('/my/stores', protect, getMyStoresHandler);

// ============================================
// PUBLIC ROUTES — STATIC PATHS BEFORE PARAM ROUTES
// ============================================

// '/check-slug' and '/slug/:slug' must come before '/:storeId'.
router.get('/check-slug', validate(checkStoreSlugSchema), (req, res) => {
  res.status(200).json({ success: true, available: true });
});
router.get('/slug/:slug', getStoreBySlugHandler);

// Param route must be registered LAST among GET '/' routes at this level.
router.get('/:storeId', getStoreHandler);

// ============================================
// SELLER ROUTES (Create, Update, Delete, Close)
// ============================================

// Create a store (instant activation — no approval)
router.post('/', protect, validate(createStoreSchema), createStoreHandler);

// Update a store
router.put('/:storeId', protect, validate(updateStoreSchema), updateStoreHandler);

// Soft delete a store (only if closed)
router.delete('/:storeId', protect, deleteStoreHandler);

// Get store status (gatekeeper)
router.get('/:storeId/status', protect, getStoreStatusHandler);

// Close own store
router.post('/:storeId/close', protect, validate(closeStoreSchema), closeStoreHandler);

// ============================================
// ADMIN ROUTES
// ============================================

// List all stores with filters
router.get(
  '/admin/stores',
  protect,
  requireAdmin,
  validate(getStoresQuerySchema),
  getAllStores
);

// Get store statistics
router.get(
  '/admin/stores/stats',
  protect,
  requireAdmin,
  getStoreStatsAdmin
);

// Suspend a store
router.post(
  '/admin/stores/:storeId/suspend',
  protect,
  requireAdmin,
  validate(suspendStoreSchema),
  suspendStoreHandler
);

// Reinstate a suspended store
router.post(
  '/admin/stores/:storeId/reinstate',
  protect,
  requireAdmin,
  validate(reinstateStoreSchema),
  reinstateStoreHandler
);

// Close a store (admin)
router.post(
  '/admin/stores/:storeId/close',
  protect,
  requireAdmin,
  validate(closeStoreSchema),
  adminCloseStoreHandler
);

export default router;