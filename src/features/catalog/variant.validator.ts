// src/features/catalog/variant.validator.ts
import { z } from 'zod';
import {
  booleanQuery,
  optionalSortOrderSchema,
  paginationSchema,
  slugSchema,
  sortDirectionSchema,
  uuidSchema,
} from './common.validator';

// ============================================
// Variant attribute input
// ============================================

/**
 * One variant attribute binding. The attribute MUST be flagged
 * `is_variant = true` on its definition, and the option MUST belong
 * to that attribute. Service layer enforces both.
 */
export const variantAttributeInputSchema = z.object({
  attribute_id: uuidSchema,
  value_option_id: uuidSchema,
});

export type VariantAttributeInput = z.infer<typeof variantAttributeInputSchema>;

/** Enforces uniqueness of attribute_id within one variant's attribute list. */
const variantAttributesArraySchema = z
  .array(variantAttributeInputSchema)
  .max(20)
  .refine(
    (arr) => new Set(arr.map((a) => a.attribute_id)).size === arr.length,
    { message: 'Duplicate attribute_id in variant attributes' },
  );

// ============================================
// Variant create
// ============================================

export const createVariantSchema = z.object({
  params: z.object({ productId: uuidSchema }),
  body: z.object({
    sku: z
      .string()
      .min(1, 'SKU is required')
      .max(100, 'SKU must be at most 100 characters')
      .trim(),

    price: z.coerce.number().nonnegative('Price must be >= 0'),
    compare_price: z.coerce.number().nonnegative().optional().nullable(),
    cost_price: z.coerce.number().nonnegative().optional().nullable(),

    quantity: z.coerce.number().int().min(0, 'Quantity must be >= 0'),
    low_stock_threshold: z.coerce.number().int().min(0).default(5),

    image_url: z.string().url().max(2048).optional().nullable(),

    position: optionalSortOrderSchema,

    is_active: z.boolean().default(true),

    attributes: variantAttributesArraySchema.min(1, {
      message: 'A variant must have at least one attribute',
    }),
  }),
});

export type CreateVariantBody = z.infer<typeof createVariantSchema>['body'];

// ============================================
// Variant update
// ============================================

export const updateVariantSchema = z.object({
  params: z.object({
    productId: uuidSchema,
    variantId: uuidSchema,
  }),
  body: z
    .object({
      sku: z.string().min(1).max(100).trim().optional(),

      price: z.coerce.number().nonnegative().optional(),
      compare_price: z.coerce.number().nonnegative().optional().nullable(),
      cost_price: z.coerce.number().nonnegative().optional().nullable(),

      quantity: z.coerce.number().int().min(0).optional(),
      low_stock_threshold: z.coerce.number().int().min(0).optional(),

      image_url: z.string().url().max(2048).optional().nullable(),

      position: optionalSortOrderSchema,

      is_active: z.boolean().optional(),

      /**
       * Full replacement of attribute bindings when provided.
       * Omit to leave existing bindings untouched.
       */
      attributes: variantAttributesArraySchema.min(1).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export type UpdateVariantBody = z.infer<typeof updateVariantSchema>['body'];

// ============================================
// Variant inventory (targeted stock updates)
// ============================================

export const updateVariantStockSchema = z.object({
  params: z.object({
    productId: uuidSchema,
    variantId: uuidSchema,
  }),
  body: z.object({
    /** Absolute set OR relative delta — exactly one. */
    quantity: z.coerce.number().int().min(0).optional(),
    delta: z.coerce.number().int().optional(),
  }).refine(
    (d) => (d.quantity === undefined) !== (d.delta === undefined),
    { message: 'Provide exactly one of quantity or delta' },
  ),
});

export type UpdateVariantStockBody = z.infer<typeof updateVariantStockSchema>['body'];

// ============================================
// Variant bulk operations
// ============================================

export const bulkCreateVariantsSchema = z.object({
  params: z.object({ productId: uuidSchema }),
  body: z.object({
    variants: z.array(createVariantSchema.shape.body).min(1).max(200),
    /** When true, wipe existing variants first. */
    replace_all: z.boolean().default(false),
  }),
});

export type BulkCreateVariantsBody = z.infer<typeof bulkCreateVariantsSchema>['body'];

export const bulkVariantStatusSchema = z.object({
  params: z.object({ productId: uuidSchema }),
  body: z.object({
    variant_ids: z.array(uuidSchema).min(1).max(200),
    is_active: z.boolean(),
  }),
});

export type BulkVariantStatusBody = z.infer<typeof bulkVariantStatusSchema>['body'];

export const reorderVariantsSchema = z.object({
  params: z.object({ productId: uuidSchema }),
  body: z.object({
    /** Ordered list of variant ids as they should appear. */
    ordered_ids: z.array(uuidSchema).min(1).max(200),
  }),
});

export type ReorderVariantsBody = z.infer<typeof reorderVariantsSchema>['body'];

// ============================================
// Variant query (list variants for a product)
// ============================================

export const variantQuerySchema = z.object({
  params: z.object({ productId: uuidSchema }),
  query: z.object({
    ...paginationSchema,
    is_active: booleanQuery(),
    /** Only variants with stock > 0. */
    in_stock: booleanQuery(),
    /** Only variants with stock <= low_stock_threshold. */
    low_stock: booleanQuery(),
    search: z.string().min(1).max(100).optional(),
    sort: z
      .enum(['position', 'price', 'quantity', 'created_at'])
      .default('position'),
    order: sortDirectionSchema.default('asc'),
  }),
});

export type VariantQuery = z.infer<typeof variantQuerySchema>['query'];

// ============================================
// Response schemas
// ============================================

export const variantAttributeResponseSchema = z.object({
  attribute_id: uuidSchema,
  attribute_slug: z.string(),
  attribute_name: z.string(),
  option_id: uuidSchema,
  option_value: z.string(),
  option_slug: z.string(),
  option_swatch: z.string().nullable(),
});

export const variantResponseSchema = z.object({
  id: uuidSchema,
  product_id: uuidSchema,
  sku: z.string(),

  price: z.number(),
  compare_price: z.number().nullable(),
  cost_price: z.number().nullable(),

  quantity: z.number().int(),
  low_stock_threshold: z.number().int(),
  /** Derived: quantity <= low_stock_threshold. */
  is_low_stock: z.boolean(),
  /** Derived: quantity === 0. */
  is_out_of_stock: z.boolean(),

  image_url: z.string().nullable(),
  position: z.number().int(),
  is_active: z.boolean(),

  attributes: z.array(variantAttributeResponseSchema),

  created_at: z.date(),
  updated_at: z.date(),
});

export type VariantResponse = z.infer<typeof variantResponseSchema>;