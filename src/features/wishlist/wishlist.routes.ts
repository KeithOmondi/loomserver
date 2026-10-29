// src/features/wishlist/wishlist.routes.ts

import { Router } from 'express';
import { protect } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  productIdParamSchema,
  addToWishlistSchema,
  listWishlistQuerySchema,
} from './wishlist.validator';
import {
  getWishlistHandler,
  addToWishlistHandler,
  removeFromWishlistHandler,
  checkWishlistedHandler,
  checkWishlistedBatchHandler,
  clearWishlistHandler,
} from './wishlist.controller';

const router = Router();

// ============================================================
// WISHLIST ROUTES
//
// Unlike cart, the wishlist is AUTH-ONLY. There are no guest
// wishlists — saving items requires an account. `protect` runs
// on every route, so `req.user` is guaranteed to be populated
// by the time the handlers run.
// ============================================================

// ------------------------------------------------------------
// Batch check — MUST come before /check/:productId so
// "check-batch" isn't swallowed by the dynamic route
// ------------------------------------------------------------

/**
 * POST /api/v1/wishlist/check-batch
 * Body: { product_ids: string[] }
 * Returns: { wishlisted_ids: string[] }
 *
 * Used by product grids to render filled/empty hearts in one query
 * instead of N separate requests.
 */
router.post(
  '/check-batch',
  protect,
  checkWishlistedBatchHandler,
);

// ------------------------------------------------------------
// Single item check
// ------------------------------------------------------------

/**
 * GET /api/v1/wishlist/check/:productId
 * Returns: { wishlisted: boolean }
 */
router.get(
  '/check/:productId',
  protect,
  validate(productIdParamSchema),
  checkWishlistedHandler,
);

// ------------------------------------------------------------
// List
// ------------------------------------------------------------

/**
 * GET /api/v1/wishlist?page=1&limit=40&sort=newest
 * Returns: { wishlist: { items, item_count } }
 */
router.get(
  '/',
  protect,
  validate(listWishlistQuerySchema),
  getWishlistHandler,
);

// ------------------------------------------------------------
// Add
// ------------------------------------------------------------

/**
 * POST /api/v1/wishlist
 * Body: { product_id: string }
 * Returns: { wishlist, added: boolean }
 */
router.post(
  '/',
  protect,
  validate(addToWishlistSchema),
  addToWishlistHandler,
);

// ------------------------------------------------------------
// Remove one
// ------------------------------------------------------------

/**
 * DELETE /api/v1/wishlist/:productId
 * Returns: { wishlist, removed: boolean }
 */
router.delete(
  '/:productId',
  protect,
  validate(productIdParamSchema),
  removeFromWishlistHandler,
);

// ------------------------------------------------------------
// Clear all
// ------------------------------------------------------------

/**
 * DELETE /api/v1/wishlist
 * Returns: { wishlist: { items: [], item_count: 0 } }
 */
router.delete(
  '/',
  protect,
  clearWishlistHandler,
);

export default router;