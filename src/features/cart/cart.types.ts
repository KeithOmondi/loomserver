// src/features/cart/cart.types.ts

import type { Timestamped, UUID } from '../catalog/common.types';
import type { ProductImage, ProductStatus } from '../products/product.types';

// ============================================
// CORE ENTITY — matches `carts` table
// ============================================

export interface Cart extends Timestamped {
  id: UUID;

  /** Set when the cart belongs to a logged-in user. */
  user_id: UUID | null;

  /** Set when the cart belongs to an anonymous guest. */
  guest_token: UUID | null;

  /** Last time the cart was touched — used to expire stale guest carts. */
  last_activity_at: Date;
}

// ============================================
// CART ITEM — matches `cart_items` table
// ============================================

export interface CartItem extends Timestamped {
  id: UUID;
  cart_id: UUID;
  product_id: UUID;
  /** Nullable for v1 — variants come later. */
  variant_id: UUID | null;
  quantity: number;
  /** Snapshot of the price at add-time. Recalculated live on checkout. */
  unit_price: number;
}

// ============================================
// HYDRATED SHAPES — what the API returns
// ============================================

/** Minimal product shape embedded in each cart line. */
export interface CartItemProduct {
  id: UUID;
  name: string;
  slug: string;
  price: number;
  compare_at_price: number | null;
  status: ProductStatus;
  stock_quantity: number;
  stock_status: string;
  is_active: boolean;
  /** First image (primary if flagged, else lowest sort_order). */
  image: ProductImage | null;
}

/** A single line in the cart response. */
export interface CartLine {
  /** The `cart_items.id` — used for PATCH/DELETE by id. */
  id: UUID;

  product: CartItemProduct;

  quantity: number;
  unit_price: number;
  /** quantity × unit_price, computed server-side. */
  line_total: number;

  /** True when the product can currently be purchased. */
  in_stock: boolean;
  /** True when the seller/product is no longer active. */
  is_available: boolean;
}

/** Full cart response shape. */
export interface CartWithItems {
  id: UUID;

  /** Present only for guest carts. Client persists it and re-sends via `X-Cart-Token`. */
  guest_token?: UUID;

  items: CartLine[];

  /** Sum of all line_total values. */
  subtotal: number;

  /** Sum of all quantities. Used for the badge on the cart tab. */
  item_count: number;
}

// ============================================
// INPUTS — request bodies
// ============================================

export interface AddCartItemInput {
  product_id: UUID;
  /** Optional for v1. If omitted, adds the base product. */
  variant_id?: UUID | null;
  /** Defaults to 1 if omitted. */
  quantity?: number;
}

export interface UpdateCartItemInput {
  quantity: number;
}

export interface MergeCartInput {
  /** The guest token to merge into the authenticated user's cart. */
  guest_token: UUID;
}

// ============================================
// INTERNAL — context passed around the service layer
// ============================================

/**
 * Resolved cart ownership context. The service layer normalizes either
 * an authenticated user or a guest token into this shape before doing
 * any DB work, so downstream code doesn't have to branch.
 */
export type CartOwner =
  | { kind: 'user'; user_id: UUID }
  | { kind: 'guest'; guest_token: UUID };

// ============================================
// RESPONSE WRAPPER
// ============================================

export interface CartResponse {
  success: boolean;
  message?: string;
  data: {
    cart: CartWithItems;
  };
}

export interface MergeCartResponse {
  success: boolean;
  message: string;
  data: {
    cart: CartWithItems;
    /** How many guest items were moved into the user cart. */
    merged_items: number;
  };
}