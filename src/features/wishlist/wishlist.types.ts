// src/features/wishlist/wishlist.types.ts

import type { Timestamped, UUID } from '../catalog/common.types';
import type { ProductImage, ProductStatus } from '../products/product.types';

// ============================================
// CORE ENTITY — matches `wishlists` table
// ============================================

/**
 * One saved product for a user. Unlike cart, wishlist rows carry no
 * quantity and no snapshot pricing — a wishlist is a "save for later"
 * bookmark that always reflects the live product.
 *
 * Deletion semantics:
 *   - If a product is hard-deleted from the platform, the row goes too
 *     (ON DELETE CASCADE on product_id).
 *   - If a user is deleted, their wishlist goes too (ON DELETE CASCADE
 *     on user_id).
 */
export interface WishlistItem extends Timestamped {
  id: UUID;
  user_id: UUID;
  product_id: UUID;
}

// ============================================
// HYDRATED SHAPES — what the API returns
// ============================================

/**
 * The product details embedded in each wishlist response row.
 *
 * Trimmed to what the wishlist grid needs:
 *   - name, slug, price, compare_at_price for display
 *   - image (primary) for the thumbnail
 *   - stock_status + is_active so the UI can grey out unavailable items
 */
export interface WishlistItemProduct {
  id: UUID;
  name: string;
  slug: string;
  price: number;
  compare_at_price: number | null;
  status: ProductStatus;
  is_active: boolean;
  stock_quantity: number;
  stock_status: string;
  /** First image (primary if flagged, else lowest sort_order). */
  image: ProductImage | null;
}

/**
 * A single row in the wishlist response.
 * Wraps the joined product details + the saved-at timestamp.
 */
export interface WishlistRow {
  /** The `wishlists.id` — used for DELETE by id if the client wants it. */
  id: UUID;
  product: WishlistItemProduct;
  /** When the user saved this item — useful for "sort by recently added". */
  saved_at: Date;
}

/**
 * Full response shape for GET /wishlist.
 */
export interface Wishlist {
  items: WishlistRow[];
  item_count: number;
}

// ============================================
// INPUTS — request bodies
// ============================================

export interface AddToWishlistInput {
  product_id: UUID;
}

// ============================================
// RESPONSE WRAPPERS
// ============================================

export interface WishlistResponse {
  success: boolean;
  message?: string;
  data: {
    wishlist: Wishlist;
  };
}

export interface WishlistCheckResponse {
  success: boolean;
  data: {
    /** True when the given product is in the current user's wishlist. */
    wishlisted: boolean;
  };
}