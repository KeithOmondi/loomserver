// src/features/cart/cart.validator.ts

import { z } from 'zod';

// ============================================
// SHARED FIELDS
// ============================================

const uuidSchema = z.string().uuid('Invalid UUID format');

const quantitySchema = z
  .number()
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(999, 'Quantity cannot exceed 999');

const guestTokenSchema = z
  .string()
  .uuid('Guest token must be a valid UUID');

// ============================================
// PARAMS
// ============================================

/** PATCH /cart/items/:itemId  ·  DELETE /cart/items/:itemId */
export const cartItemIdParamSchema = z.object({
  params: z.object({
    itemId: uuidSchema,
  }),
});

// ============================================
// HEADERS — guest carts send X-Cart-Token
// ============================================

/**
 * Optional header. Present for guest carts; absent for authenticated ones.
 * The service layer validates that either a user OR a token is provided.
 */
export const cartHeadersSchema = z.object({
  headers: z.object({
    'x-cart-token': guestTokenSchema.optional(),
  }).passthrough(),   // allow other headers through
});

// ============================================
// BODIES
// ============================================

/** POST /cart/items */
export const addCartItemSchema = z.object({
  body: z.object({
    product_id: uuidSchema,
    variant_id: uuidSchema.optional().nullable(),
    quantity: quantitySchema.default(1),
  }),
});

/** PATCH /cart/items/:itemId */
export const updateCartItemSchema = z.object({
  params: z.object({
    itemId: uuidSchema,
  }),
  body: z.object({
    quantity: quantitySchema,
  }),
});

/** POST /cart/merge */
export const mergeCartSchema = z.object({
  body: z.object({
    guest_token: guestTokenSchema,
  }),
});

// ============================================
// RESPONSE SCHEMAS (documentation / testing only)
// ============================================

export const cartItemProductSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  slug: z.string(),
  price: z.number(),
  compare_at_price: z.number().nullable(),
  status: z.string(),
  stock_quantity: z.number().int(),
  stock_status: z.string(),
  is_active: z.boolean(),
  image: z
    .object({
      id: uuidSchema,
      product_id: uuidSchema,
      url: z.string().url(),
      public_id: z.string(),
      alt_text: z.string().nullable(),
      is_primary: z.boolean(),
      sort_order: z.number().int(),
      metadata: z.record(z.string(), z.unknown()).nullable(),
      created_at: z.date(),
    })
    .nullable(),
});

export const cartLineSchema = z.object({
  id: uuidSchema,
  product: cartItemProductSchema,
  quantity: z.number().int().min(1),
  unit_price: z.number(),
  line_total: z.number(),
  in_stock: z.boolean(),
  is_available: z.boolean(),
});

export const cartWithItemsSchema = z.object({
  id: uuidSchema,
  guest_token: uuidSchema.optional(),
  items: z.array(cartLineSchema),
  subtotal: z.number(),
  item_count: z.number().int().min(0),
});

// ============================================
// TYPE INFERENCE
// ============================================

export type CartItemIdParams = z.infer<typeof cartItemIdParamSchema>['params'];
export type AddCartItemBody = z.infer<typeof addCartItemSchema>['body'];
export type UpdateCartItemBody = z.infer<typeof updateCartItemSchema>['body'];
export type MergeCartBody = z.infer<typeof mergeCartSchema>['body'];