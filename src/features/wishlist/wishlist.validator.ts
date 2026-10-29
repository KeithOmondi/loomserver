// src/features/wishlist/wishlist.validator.ts

import { z } from 'zod';

// ============================================
// SHARED FIELDS
// ============================================

const uuidSchema = z.string().uuid('Invalid UUID format');

// ============================================
// PARAMS
// ============================================

/** DELETE /wishlist/:productId  ·  GET /wishlist/check/:productId */
export const productIdParamSchema = z.object({
  params: z.object({
    productId: uuidSchema,
  }),
});

// ============================================
// BODIES
// ============================================

/** POST /wishlist */
export const addToWishlistSchema = z.object({
  body: z.object({
    product_id: uuidSchema,
  }),
});

// ============================================
// QUERY
// ============================================

/**
 * GET /wishlist
 *
 * Optional pagination + sort for users with big wishlists. Defaults
 * match the cart's pagination style (page 1, 20 per page) but the
 * wishlist is likely smaller, so 40 is a reasonable default.
 */
export const listWishlistQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(40),
    sort: z
      .enum(['newest', 'oldest', 'price_asc', 'price_desc'])
      .optional()
      .default('newest'),
  }),
});

// ============================================
// TYPE INFERENCE
// ============================================

export type ProductIdParams = z.infer<typeof productIdParamSchema>['params'];
export type AddToWishlistBody = z.infer<typeof addToWishlistSchema>['body'];
export type ListWishlistQuery = z.infer<
  typeof listWishlistQuerySchema
>['query'];