// src/features/product/product.routes.ts

import { Router } from 'express';
import {
  protect,
  requireAdmin,
  requireModerator,
} from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';

// ✅ NEW: multer for product images
//import { uploadProductImages } from '../../middlewares/upload.middleware';
import { parseProductMultipart } from '../catalog/product.multipart';

import {
  createProductSchema,
  updateProductSchema,
  getProductsQuerySchema,
  createProductReviewSchema,
  updateProductReviewSchema,
  moderateProductReviewSchema,
  adjustStockSchema,
  bulkProductSchema,
  checkProductSlugSchema,
  productMetricsSchema,
  moderateProductSchema,
} from './product.validator';
import {
  // Seller — self
  createProductHandler,
  getMyProductsHandler,
  updateProductHandler,
  deleteProductHandler,
  getProductStatusHandler,
  submitProductForApproval,
  getProductMetricsHandler,

  // Public
  getProductsHandler,
  getProductHandler,
  getProductBySlugHandler,
  getStoreProductsHandler,

  // Reviews
  createProductReviewHandler,
  getProductReviewsHandler,

  // Admin
  getAllProductsAdmin,
  getProductAdmin,
  approveProductHandler,
  bulkProductOperation,
  getProductStatsAdmin,

  // Moderator
  getPendingProductsModerator,
  getProductForReviewModerator,
  reviewProductModerator,
  moderateProductReviewHandler,
} from './product.controller';
import { uploadProductImages } from '../../middlewares/upload';

const router = Router();

// ============================================================
// ROUTE ORDER
//
// Express matches top-down, first match wins.
// Order:
//   1. Static single-segment     (/, /my, /check-slug)
//   2. Fully-nested static       (/reviews, /admin/..., /moderator/...,
//                                 /stores/:storeId/products)
//   3. Nested under /:productId  (/:productId/submit, /:productId/...)
//   4. Public /slug/:slug
//   5. Public /:productId        (LAST)
// ============================================================

// ============================================================
// 1. STATIC SINGLE-SEGMENT
// ============================================================

// Public listing
router.get('/', validate(getProductsQuerySchema), getProductsHandler);

// Seller's own products
router.get('/my', protect, getMyProductsHandler);

// Slug availability check
router.get('/check-slug', validate(checkProductSlugSchema), (_req, res) => {
  res.status(200).json({ success: true, available: true });
});

// ============================================================
// 2. NESTED STATIC PREFIXES
// ============================================================

// ---- Reviews ----

router.post(
  '/reviews',
  protect,
  validate(createProductReviewSchema),
  createProductReviewHandler
);

router.put(
  '/reviews/:reviewId',
  protect,
  validate(updateProductReviewSchema),
  (_req, res) => {
    res.status(200).json({ success: true, message: 'Review updated' });
  }
);

router.delete('/reviews/:reviewId', protect, (_req, res) => {
  res.status(200).json({ success: true, message: 'Review deleted' });
});

// ---- Admin ----

router.get(
  '/admin/products',
  protect,
  requireAdmin,
  validate(getProductsQuerySchema),
  getAllProductsAdmin
);

router.get(
  '/admin/products/stats',
  protect,
  requireAdmin,
  getProductStatsAdmin
);

router.post(
  '/admin/products/bulk',
  protect,
  requireAdmin,
  validate(bulkProductSchema),
  bulkProductOperation
);

router.get(
  '/admin/products/:productId',
  protect,
  requireAdmin,
  getProductAdmin
);

router.put(
  '/admin/products/:productId/approve',
  protect,
  requireAdmin,
  validate(moderateProductSchema),
  approveProductHandler
);

// ---- Moderator ----

router.get(
  '/moderator/products/pending',
  protect,
  requireModerator,
  validate(getProductsQuerySchema),
  getPendingProductsModerator
);

router.get(
  '/moderator/products/:productId',
  protect,
  requireModerator,
  getProductForReviewModerator
);

router.put(
  '/moderator/products/:productId/review',
  protect,
  requireModerator,
  validate(moderateProductSchema),
  reviewProductModerator
);

router.put(
  '/moderator/reviews/:reviewId',
  protect,
  requireModerator,
  validate(moderateProductReviewSchema),
  moderateProductReviewHandler
);

// ---- Store-scoped public listing ----

router.get(
  '/stores/:storeId/products',
  validate(getProductsQuerySchema),
  getStoreProductsHandler
);

// ---- Seller: create inside a store ----
//
// ✅ Multipart-aware:
//   1. `uploadProductImages` — multer parses multipart/form-data
//      (accepts `images` field, up to 10 files, 10MB each).
//   2. `parseProductMultipart` — coerces string fields back to their
//      proper types (numbers, booleans, JSON objects) and attaches
//      `req.files` as `req.body.images`.
//   3. `validate(createProductSchema)` — Zod sees the corrected types.
//
// JSON requests still work: `uploadProductImages` is a no-op for
// non-multipart content types, and `parseProductMultipart` exits early.
router.post(
  '/stores/:storeId/products',
  protect,
  uploadProductImages,
  parseProductMultipart,
  validate(createProductSchema),
  createProductHandler
);

// ============================================================
// 3. NESTED UNDER /:productId
// ============================================================

// Public reads bound to a product
router.get('/:productId/reviews', getProductReviewsHandler);

// Seller-owned operations
router.get('/:productId/status', protect, getProductStatusHandler);

router.get(
  '/:productId/metrics',
  protect,
  validate(productMetricsSchema),
  getProductMetricsHandler
);

router.post(
  '/:productId/stock',
  protect,
  validate(adjustStockSchema),
  (_req, res) => {
    res.status(200).json({ success: true, message: 'Stock adjusted' });
  }
);

router.post('/:productId/submit', protect, submitProductForApproval);

// ✅ Update route — same multipart pipeline as create
router.put(
  '/:productId',
  protect,
  uploadProductImages,
  parseProductMultipart,
  validate(updateProductSchema),
  updateProductHandler
);

router.delete('/:productId', protect, deleteProductHandler);

// ============================================================
// 4. PUBLIC — SLUG LOOKUP
// ============================================================

router.get('/slug/:slug', getProductBySlugHandler);

// ============================================================
// 5. PUBLIC — DYNAMIC (LAST)
// ============================================================

router.get('/:productId', getProductHandler);

export default router;