// src/features/wishlist/wishlist.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  isWishlisted,
  clearWishlist,
  getWishlistedProductIds,
} from './wishlist.service';

// ============================================
// HELPERS
// ============================================

const extractString = (param: string | string[] | undefined): string => {
  if (!param) throw new AppError(400, 'Parameter is required');
  return Array.isArray(param) ? param[0] : param;
};

const requireUser = (req: Request): NonNullable<Request['user']> => {
  if (!req.user) throw new AppError(401, 'Authentication required.');
  return req.user;
};

// ============================================
// HANDLER — GET /wishlist
// ============================================

/**
 * List the authenticated user's wishlist with pagination + sort.
 * Query is pre-validated by `listWishlistQuerySchema`.
 */
export const getWishlistHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const wishlist = await getWishlist(user.id, req.query as any);

    res.status(200).json({
      success: true,
      data: { wishlist },
    });
  },
);

// ============================================
// HANDLER — POST /wishlist
// ============================================

/**
 * Add a product to the wishlist. Idempotent — re-adding is a no-op
 * and returns success with `added: false`.
 */
export const addToWishlistHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { product_id } = req.body;

    const { added } = await addToWishlist(user.id, product_id);

    // Return a fresh wishlist so the UI can update its state atomically
    const wishlist = await getWishlist(user.id, {
      page: 1,
      limit: 100,
      sort: 'newest',
    });

    res.status(200).json({
      success: true,
      message: added ? 'Added to wishlist.' : 'Already in your wishlist.',
      data: { wishlist, added },
    });
  },
);

// ============================================
// HANDLER — DELETE /wishlist/:productId
// ============================================

/**
 * Remove a product from the wishlist. Idempotent.
 */
export const removeFromWishlistHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);
    const productId = extractString(req.params.productId);

    const { removed } = await removeFromWishlist(user.id, productId);

    // Return a fresh wishlist for the same reason as add
    const wishlist = await getWishlist(user.id, {
      page: 1,
      limit: 100,
      sort: 'newest',
    });

    res.status(200).json({
      success: true,
      message: removed ? 'Removed from wishlist.' : 'Item was not in your wishlist.',
      data: { wishlist, removed },
    });
  },
);

// ============================================
// HANDLER — GET /wishlist/check/:productId
// ============================================

/**
 * Cheap boolean check — is a single product on this user's wishlist?
 * Used by the product detail screen.
 */
export const checkWishlistedHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);
    const productId = extractString(req.params.productId);

    const wishlisted = await isWishlisted(user.id, productId);

    res.status(200).json({
      success: true,
      data: { wishlisted },
    });
  },
);

// ============================================
// HANDLER — POST /wishlist/check-batch
// ============================================

/**
 * Batch check — given an array of product ids, return the subset
 * that this user has wishlisted. Used by grids (shop, categories)
 * so each card knows whether to render a filled or empty heart
 * without N separate requests.
 *
 * Body: { product_ids: string[] }
 */
export const checkWishlistedBatchHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);
    const { product_ids } = req.body as { product_ids: string[] };

    if (!Array.isArray(product_ids)) {
      throw new AppError(400, 'product_ids must be an array.');
    }

    // Cap the batch size to prevent abuse
    if (product_ids.length > 200) {
      throw new AppError(400, 'Maximum 200 product ids per request.');
    }

    const map = await getWishlistedProductIds(user.id, product_ids);

    res.status(200).json({
      success: true,
      data: { wishlisted_ids: Object.keys(map) },
    });
  },
);

// ============================================
// HANDLER — DELETE /wishlist
// ============================================

/**
 * Clear the entire wishlist for the authenticated user.
 */
export const clearWishlistHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    await clearWishlist(user.id);

    res.status(200).json({
      success: true,
      message: 'Wishlist cleared.',
      data: {
        wishlist: { items: [], item_count: 0 },
      },
    });
  },
);