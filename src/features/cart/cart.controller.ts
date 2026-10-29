// src/features/cart/cart.controller.ts

import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import {
  getCart,
  addItem,
  updateItemQuantity,
  removeItem,
  clearCart,
  mergeGuestCart,
  resolveCartOwner,
} from './cart.service';
import type { CartOwner } from './cart.types';

// ============================================
// HELPERS
// ============================================

const GUEST_TOKEN_HEADER = 'x-cart-token';

/**
 * Extract a single string from an Express param. `req.params` values are
 * typed as `string | string[]` because catch-all routes can produce arrays.
 * For named params (`:itemId`) Express always delivers a string at runtime.
 */
const extractString = (param: string | string[] | undefined): string => {
  if (!param) throw new AppError(400, 'Parameter is required');
  return Array.isArray(param) ? param[0] : param;
};

/**
 * Read the guest cart token from the request header, if present.
 */
const extractGuestToken = (req: Request): string | undefined => {
  const raw = req.headers[GUEST_TOKEN_HEADER];
  if (!raw) return undefined;
  const token = Array.isArray(raw) ? raw[0] : raw;
  return token || undefined;
};

/**
 * Resolve the CartOwner for this request.
 *
 * - Authenticated user → owned by user_id
 * - Guest with token   → owned by guest_token
 * - Guest without token → generate a fresh guest_token; the service will
 *   persist a new cart under it and return it in the response so the
 *   client can store it for future calls.
 */
const ownerFromRequest = (req: Request): CartOwner => {
  const userId = req.user?.id;
  if (userId) return { kind: 'user', user_id: userId };

  const guestToken = extractGuestToken(req) ?? randomUUID();
  return { kind: 'guest', guest_token: guestToken };
};

// ============================================
// HANDLER — GET /cart
// ============================================

export const getCartHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const owner = ownerFromRequest(req);
    const cart = await getCart(owner);

    res.status(200).json({
      success: true,
      data: { cart },
    });
  },
);

// ============================================
// HANDLER — POST /cart/items
// ============================================

export const addItemHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const owner = ownerFromRequest(req);
    const cart = await addItem(owner, req.body);

    res.status(200).json({
      success: true,
      message: 'Item added to cart.',
      data: { cart },
    });
  },
);

// ============================================
// HANDLER — PATCH /cart/items/:itemId
// ============================================

export const updateItemHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const owner = ownerFromRequest(req);
    const itemId = extractString(req.params.itemId);

    const cart = await updateItemQuantity(owner, itemId, req.body);

    res.status(200).json({
      success: true,
      message: 'Cart updated.',
      data: { cart },
    });
  },
);

// ============================================
// HANDLER — DELETE /cart/items/:itemId
// ============================================

export const removeItemHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const owner = ownerFromRequest(req);
    const itemId = extractString(req.params.itemId);

    const cart = await removeItem(owner, itemId);

    res.status(200).json({
      success: true,
      message: 'Item removed from cart.',
      data: { cart },
    });
  },
);

// ============================================
// HANDLER — DELETE /cart
// ============================================

export const clearCartHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const owner = ownerFromRequest(req);
    const cart = await clearCart(owner);

    res.status(200).json({
      success: true,
      message: 'Cart cleared.',
      data: { cart },
    });
  },
);

// ============================================
// HANDLER — POST /cart/merge
// ============================================

export const mergeCartHandler = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.user) {
      throw new AppError(401, 'Authentication required to merge cart.');
    }

    const { guest_token } = req.body;
    const { cart, merged_items } = await mergeGuestCart(
      req.user.id,
      guest_token,
    );

    res.status(200).json({
      success: true,
      message: `Merged ${merged_items} item${merged_items === 1 ? '' : 's'}.`,
      data: { cart, merged_items },
    });
  },
);