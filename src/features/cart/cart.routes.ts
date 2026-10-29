// src/features/cart/cart.routes.ts

import { Router } from 'express';
import { protect, protectOptional } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  cartItemIdParamSchema,
  addCartItemSchema,
  updateCartItemSchema,
  mergeCartSchema,
} from './cart.validator';
import {
  getCartHandler,
  addItemHandler,
  updateItemHandler,
  removeItemHandler,
  clearCartHandler,
  mergeCartHandler,
} from './cart.controller';

const router = Router();

// ============================================================
// CART ROUTES
//
// Every route accepts EITHER an authenticated user OR a guest with an
// `X-Cart-Token` header. `protectOptional` populates `req.user` when a
// valid Bearer token is present and does nothing when it's absent — so
// the same handlers serve both.
//
// Only `/merge` requires authentication, since merging is inherently
// "attach this guest cart to my user account".
// ============================================================

// ------------------------------------------------------------
// GET /api/v1/cart
// Read the current cart. Auto-creates an empty one if none exists.
// ------------------------------------------------------------
router.get(
  '/',
  protectOptional,
  getCartHandler,
);

// ------------------------------------------------------------
// POST /api/v1/cart/items
// Add a product (increments quantity if the line already exists).
// ------------------------------------------------------------
router.post(
  '/items',
  protectOptional,
  validate(addCartItemSchema),
  addItemHandler,
);

// ------------------------------------------------------------
// PATCH /api/v1/cart/items/:itemId
// Update the quantity of a single line.
// ------------------------------------------------------------
router.patch(
  '/items/:itemId',
  protectOptional,
  validate(updateCartItemSchema),
  updateItemHandler,
);

// ------------------------------------------------------------
// DELETE /api/v1/cart/items/:itemId
// Remove a single line.
// ------------------------------------------------------------
router.delete(
  '/items/:itemId',
  protectOptional,
  validate(cartItemIdParamSchema),
  removeItemHandler,
);

// ------------------------------------------------------------
// DELETE /api/v1/cart
// Clear all lines in the cart (keeps the cart row itself).
// ------------------------------------------------------------
router.delete(
  '/',
  protectOptional,
  clearCartHandler,
);

// ------------------------------------------------------------
// POST /api/v1/cart/merge
// Called by the client immediately after login. Moves all items from the
// guest cart (identified by `guest_token` in the body) into the
// authenticated user's cart, then deletes the guest cart.
//
// This is the ONLY cart route that requires authentication.
// ------------------------------------------------------------
router.post(
  '/merge',
  protect,
  validate(mergeCartSchema),
  mergeCartHandler,
);

export default router;