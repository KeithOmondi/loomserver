// src/features/catalog/product.validator.ts
import { z } from 'zod';

import {
  ProductCondition,
  ProductStatus,
  ProductType,
  ProductVisibility,
  ReviewStatus,
  StockStatus,
  WeightUnit,
  SELLER_CREATABLE_STATUSES,
  SELLER_MUTABLE_STATUSES,
} from './product.types';

import { productAttributeInputSchema } from '../catalog/product-attribute.validator';
import { variantAttributeInputSchema } from '../catalog/variant.validator';

// ============================================
// ENUM HELPERS (Zod v4-safe)
// ============================================

const ProductStatusEnum = z.enum(
  Object.values(ProductStatus) as [ProductStatus, ...ProductStatus[]],
);
const StockStatusEnum = z.enum(
  Object.values(StockStatus) as [StockStatus, ...StockStatus[]],
);
const ProductTypeEnum = z.enum(
  Object.values(ProductType) as [ProductType, ...ProductType[]],
);
const ProductConditionEnum = z.enum(
  Object.values(ProductCondition) as [ProductCondition, ...ProductCondition[]],
);
const ProductVisibilityEnum = z.enum(
  Object.values(ProductVisibility) as [ProductVisibility, ...ProductVisibility[]],
);
const WeightUnitEnum = z.enum(
  Object.values(WeightUnit) as [WeightUnit, ...WeightUnit[]],
);
const ReviewStatusEnum = z.enum(
  Object.values(ReviewStatus) as [ReviewStatus, ...ReviewStatus[]],
);

const DimensionUnitEnum = z.enum(['cm', 'in']);

// ============================================
// SELLER-ONLY STATUS ENUMS
// ============================================

const SellerCreateStatusEnum = z.enum(
  SELLER_CREATABLE_STATUSES as [ProductStatus, ...ProductStatus[]],
);

const SellerUpdateStatusEnum = z.enum(
  SELLER_MUTABLE_STATUSES as [ProductStatus, ...ProductStatus[]],
);

// ============================================
// ✅ IMAGE FILES SCHEMA
// ============================================
//
// Multer attaches uploaded files to `req.body.images` (via
// parseProductMultipart). The items are `Express.Multer.File` objects —
// opaque binary descriptors, not serializable data.
//
// Zod is not the right place to validate these:
//   - File type / MIME / size are checked by `uploadProductImages` middleware
//   - The service layer (`persistProductImages`) does the Cloudinary upload
//
// We use `z.array(z.any())` as an escape hatch so:
//   1. Zod's `.strict()` doesn't reject the `images` key
//   2. TS keeps `input.images` typed as `Express.Multer.File[]`
//   3. No meaningless validation runs on File objects

const imageFilesField = z.array(z.any()).optional();

// ============================================
// FIELD HELPERS
// ============================================

const idField = z.string().uuid('Invalid UUID format');
const optionalIdField = z.string().uuid('Invalid UUID format').optional();

const nameField = z
  .string()
  .min(2, 'Product name must be at least 2 characters')
  .max(255, 'Product name cannot exceed 255 characters')
  .trim();

const descriptionField = z
  .string()
  .max(10000, 'Description cannot exceed 10000 characters')
  .trim()
  .optional();

const shortDescriptionField = z
  .string()
  .max(500, 'Short description cannot exceed 500 characters')
  .trim()
  .optional();

const priceField = z
  .number()
  .min(0, 'Price must be at least 0')
  .max(99_999_999.99, 'Price is too high');

const compareAtPriceField = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .optional()
  .nullable();

const costPerItemField = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .optional()
  .nullable();

const skuField = z.string().max(100).trim().optional().nullable();

const stockQuantityField = z
  .number()
  .int('Stock quantity must be an integer')
  .min(0, 'Stock quantity cannot be negative')
  .default(0);

const urlField = z.string().url('Invalid URL format').max(500).optional().nullable();

const tagsField = z
  .array(z.string().min(1).max(50).trim())
  .max(20, 'Maximum 20 tags allowed')
  .optional();

const dateField = z.coerce.date().optional().nullable();

// SEO sub-object (matches ProductSeo interface)
const seoSchema = z
  .object({
    meta_title: z.string().max(255).optional().nullable(),
    meta_description: z.string().max(500).optional().nullable(),
    meta_keywords: z.string().max(500).optional().nullable(),
    canonical_url: urlField,
    og_image_url: urlField,
  })
  .partial()
  .optional();

// ============================================
// DIMENSIONS
// ============================================

const dimensionsSchema = z
  .object({
    length: z.number().min(0).max(1000),
    width: z.number().min(0).max(1000),
    height: z.number().min(0).max(1000),
    unit: DimensionUnitEnum.default('cm'),
  })
  .optional()
  .nullable();

// ============================================
// VARIANT (EAV-aligned)
// ============================================

const variantBodySchema = z.object({
  sku: z.string().min(1, 'SKU is required').max(100).trim(),

  price: priceField,
  compare_at_price: compareAtPriceField,
  cost_per_item: costPerItemField,

  stock_quantity: stockQuantityField,
  stock_status: StockStatusEnum.optional(),
  low_stock_threshold: z.number().int().min(0).optional(),
  allow_backorders: z.boolean().optional(),

  weight: z.number().min(0).optional().nullable(),
  weight_unit: WeightUnitEnum.optional().nullable(),
  image_url: urlField,

  position: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),

  /** Attribute → option bindings that define this variant. */
  attributes: z.array(variantAttributeInputSchema).min(1).max(20),
});

// ============================================
// SHARED CROSS-FIELD REFINEMENTS
// ============================================

const applyProductRefinements = (
  data: {
    type?: ProductType;
    requires_shipping?: boolean;
    weight?: number | null;
    has_variants?: boolean;
    variants?: unknown[];
    stock_quantity?: number;
    price?: number;
    compare_at_price?: number | null;
    allow_preorders?: boolean;
    preorder_release_date?: Date | null;
    digital_file_url?: string | null;
  },
  ctx: z.RefinementCtx,
  mode: 'creating' | 'updating',
) => {
  if (data.type === ProductType.DIGITAL && data.requires_shipping === true) {
    ctx.addIssue({
      code: 'custom',
      message: 'Digital products do not require shipping',
      path: ['requires_shipping'],
    });
  }

  if (
    mode === 'creating' &&
    data.type === ProductType.PHYSICAL &&
    (data.weight === undefined || data.weight === null)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Physical products require weight',
      path: ['weight'],
    });
  }

  if (data.has_variants === true && (!data.variants || data.variants.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      message: 'At least one variant is required when has_variants is true',
      path: ['variants'],
    });
  }

  if (
    data.compare_at_price !== undefined &&
    data.compare_at_price !== null &&
    data.price !== undefined &&
    data.compare_at_price <= data.price
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'Compare-at price must be greater than regular price',
      path: ['compare_at_price'],
    });
  }

  if (data.allow_preorders === true && !data.preorder_release_date) {
    ctx.addIssue({
      code: 'custom',
      message: 'Preorder release date is required when preorders are enabled',
      path: ['preorder_release_date'],
    });
  }

  if (data.type === ProductType.DIGITAL && !data.digital_file_url) {
    ctx.addIssue({
      code: 'custom',
      message: 'Digital file URL is required for digital products',
      path: ['digital_file_url'],
    });
  }
};

// ============================================
// CREATE PRODUCT
// ============================================
// POST /stores/:storeId/products  (seller)

export const createProductSchema = z.object({
  params: z.object({ storeId: idField }),
  body: z
    .object({
      // Content
      name: nameField,
      slug: z.string().min(2).max(255).trim().optional(),
      description: descriptionField,
      short_description: shortDescriptionField,

      // Classification
      type: ProductTypeEnum,
      condition: ProductConditionEnum.default(ProductCondition.NEW),
      visibility: ProductVisibilityEnum.default(ProductVisibility.PUBLIC),
      category_id: optionalIdField,
      tags: tagsField,

      // Pricing
      price: priceField,
      compare_at_price: compareAtPriceField,
      cost_per_item: costPerItemField,
      tax_class: z.string().max(50).trim().optional().nullable(),
      is_taxable: z.boolean().default(true),

      // Inventory
      sku: skuField,
      barcode: z.string().max(50).trim().optional().nullable(),
      stock_quantity: stockQuantityField,
      stock_status: StockStatusEnum.optional(),
      low_stock_threshold: z.number().int().min(0).optional(),
      allow_backorders: z.boolean().default(false),
      allow_preorders: z.boolean().default(false),
      preorder_release_date: dateField,

      // Physical shipping
      weight: z.number().min(0).optional().nullable(),
      weight_unit: WeightUnitEnum.default(WeightUnit.KG),
      dimensions: dimensionsSchema,
      requires_shipping: z.boolean().default(true),
      shipping_class: z.string().max(50).trim().optional().nullable(),

      // Media (URL only — service handles file uploads separately)
      video_url: urlField,

      // Variants
      has_variants: z.boolean().default(false),
      variant_attribute_ids: z.array(idField).optional(),
      variants: z.array(variantBodySchema).optional(),

      // Digital
      digital_file_url: urlField,
      digital_file_size: z.number().min(0).optional().nullable(),
      digital_file_name: z.string().max(255).trim().optional().nullable(),

      // SEO
      seo: seoSchema,

      // EAV attributes
      attributes: z.array(productAttributeInputSchema).optional(),

      // ✅ Image files (attached by parseProductMultipart middleware)
      images: imageFilesField,

      // Lifecycle — seller may only pick draft or pending
      status: SellerCreateStatusEnum.default(ProductStatus.DRAFT),
      is_featured: z.boolean().default(false),

      metadata: z.record(z.string(), z.unknown()).optional().nullable(),
    })
    .strict()
    .superRefine((data, ctx) => applyProductRefinements(data, ctx, 'creating')),
});

// ============================================
// UPDATE PRODUCT
// ============================================
// PATCH /products/:productId  (seller)

export const updateProductSchema = z.object({
  params: z.object({ productId: idField }),
  body: z
    .object({
      name: nameField.optional(),
      slug: z.string().min(2).max(255).trim().optional(),
      description: descriptionField,
      short_description: shortDescriptionField,

      type: ProductTypeEnum.optional(),
      condition: ProductConditionEnum.optional(),
      visibility: ProductVisibilityEnum.optional(),
      category_id: optionalIdField,
      tags: tagsField,

      price: priceField.optional(),
      compare_at_price: compareAtPriceField,
      cost_per_item: costPerItemField,
      tax_class: z.string().max(50).trim().optional().nullable(),
      is_taxable: z.boolean().optional(),

      sku: skuField,
      barcode: z.string().max(50).trim().optional().nullable(),
      stock_quantity: stockQuantityField.optional(),
      stock_status: StockStatusEnum.optional(),
      low_stock_threshold: z.number().int().min(0).optional(),
      allow_backorders: z.boolean().optional(),
      allow_preorders: z.boolean().optional(),
      preorder_release_date: dateField,

      weight: z.number().min(0).optional().nullable(),
      weight_unit: WeightUnitEnum.optional(),
      dimensions: dimensionsSchema,
      requires_shipping: z.boolean().optional(),
      shipping_class: z.string().max(50).trim().optional().nullable(),

      video_url: urlField,

      has_variants: z.boolean().optional(),
      variant_attribute_ids: z.array(idField).optional(),
      variants: z.array(variantBodySchema).optional(),

      digital_file_url: urlField,
      digital_file_size: z.number().min(0).optional().nullable(),
      digital_file_name: z.string().max(255).trim().optional().nullable(),

      seo: seoSchema,
      attributes: z.array(productAttributeInputSchema).optional(),

      // ✅ Image files (attached by parseProductMultipart middleware)
      images: imageFilesField,

      status: SellerUpdateStatusEnum.optional(),
      is_featured: z.boolean().optional(),
      is_active: z.boolean().optional(),

      metadata: z.record(z.string(), z.unknown()).optional().nullable(),
    })
    .strict()
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one field must be provided',
    })
    .superRefine((data, ctx) => applyProductRefinements(data, ctx, 'updating')),
});

// ============================================
// MODERATOR REVIEW
// ============================================
// PATCH /moderator/products/:productId/review

export const moderateProductSchema = z.object({
  params: z.object({ productId: idField }),
  body: z
    .object({
      approved: z.boolean({ message: 'Approved status is required' }),
      rejection_reason: z
        .string()
        .min(1, 'Rejection reason cannot be empty')
        .max(500)
        .trim()
        .optional(),
      notes: z.string().max(1000).trim().optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (data.approved === false && !data.rejection_reason) {
        ctx.addIssue({
          code: 'custom',
          message: 'Rejection reason is required when rejecting a product',
          path: ['rejection_reason'],
        });
      }
      if (data.approved === true && data.rejection_reason) {
        ctx.addIssue({
          code: 'custom',
          message: 'rejection_reason is only allowed when rejecting',
          path: ['rejection_reason'],
        });
      }
    }),
});

// ============================================
// GET PRODUCTS QUERY
// ============================================

const booleanQueryField = z
  .enum(['true', 'false'])
  .optional()
  .transform((val) => (val === undefined ? undefined : val === 'true'));

export const getProductsQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      search: z.string().max(200).trim().optional(),

      status: z
        .union([ProductStatusEnum, z.array(ProductStatusEnum)])
        .optional()
        .transform((val) =>
          val ? (Array.isArray(val) ? val : [val]) : undefined,
        ),

      type: ProductTypeEnum.optional(),
      condition: ProductConditionEnum.optional(),

      category_id: z.string().uuid().optional(),
      category_include_descendants: booleanQueryField,

      store_id: z.string().uuid().optional(),
      seller_id: z.string().uuid().optional(),

      min_price: z.coerce.number().min(0).optional(),
      max_price: z.coerce.number().min(0).optional(),

      has_variants: booleanQueryField,
      is_active: booleanQueryField,
      is_approved: booleanQueryField,
      is_featured: booleanQueryField,
      in_stock: booleanQueryField,

      attributes: z.unknown().optional(),

      sort: z
        .enum([
          'name',
          'price_asc',
          'price_desc',
          'newest',
          'oldest',
          'popular',
          'rating',
          'sales',
          'relevance',
        ])
        .optional()
        .default('newest'),
      order: z.enum(['asc', 'desc']).optional(),

      date_from: dateField,
      date_to: dateField,
    })
    .refine(
      (q) =>
        q.min_price === undefined ||
        q.max_price === undefined ||
        q.min_price <= q.max_price,
      {
        message: 'min_price must be <= max_price',
        path: ['min_price'],
      },
    ),
});

// ============================================
// STOCK MANAGEMENT
// ============================================

export const adjustStockSchema = z.object({
  params: z.object({ productId: idField }),
  body: z.object({
    variant_id: optionalIdField,
    quantity: z.number().int().min(1, 'Quantity must be at least 1'),
    reason: z.enum(['restock', 'adjustment', 'return']),
    note: z.string().max(500).trim().optional(),
  }),
});

// ============================================
// BULK OPERATIONS
// ============================================

export const bulkProductSchema = z.object({
  body: z.object({
    product_ids: z
      .array(idField)
      .min(1, 'At least one product ID is required')
      .max(100, 'Cannot process more than 100 products at once'),
    action: z.enum([
      'activate',
      'deactivate',
      'feature',
      'unfeature',
      'delete',
      'update_status',
    ]),
    status: ProductStatusEnum.optional(),
  }),
});

// ============================================
// SLUG / METRICS
// ============================================

export const checkProductSlugSchema = z.object({
  query: z.object({
    slug: z.string().min(2).max(255),
    exclude: z.string().uuid().optional(),
    store_id: z.string().uuid().optional(),
  }),
});

export const productMetricsSchema = z.object({
  params: z.object({ productId: idField }),
  query: z.object({
    period: z
      .enum(['today', 'week', 'month', 'year', 'all'])
      .optional()
      .default('month'),
  }),
});

// ============================================
// PRODUCT REVIEWS
// ============================================

export const createProductReviewSchema = z.object({
  body: z.object({
    product_id: idField,
    order_id: optionalIdField,
    rating: z.number().int().min(1).max(5),
    title: z.string().max(100).trim().optional(),
    comment: z.string().max(5000).trim().optional(),
    images: z.array(z.string().url()).max(10).optional(),
  }),
});

export const updateProductReviewSchema = z.object({
  params: z.object({ reviewId: idField }),
  body: z.object({
    rating: z.number().int().min(1).max(5).optional(),
    title: z.string().max(100).trim().optional(),
    comment: z.string().max(5000).trim().optional(),
    images: z.array(z.string().url()).max(10).optional(),
  }),
});

export const moderateProductReviewSchema = z.object({
  params: z.object({ reviewId: idField }),
  body: z
    .object({
      approved: z.boolean({ message: 'Approval status is required' }),
      reason: z.string().max(500).trim().optional(),
    })
    .superRefine((data, ctx) => {
      if (data.approved === false && !data.reason) {
        ctx.addIssue({
          code: 'custom',
          message: 'Reason is required when rejecting a review',
          path: ['reason'],
        });
      }
    }),
});

// ============================================
// TYPE INFERENCE
// ============================================

export type CreateProductSchemaBody = z.infer<typeof createProductSchema>['body'];
export type UpdateProductSchemaBody = z.infer<typeof updateProductSchema>['body'];
export type ModerateProductSchemaBody = z.infer<typeof moderateProductSchema>['body'];
export type GetProductsQueryValidated = z.infer<typeof getProductsQuerySchema>['query'];
export type CreateProductReviewSchemaBody = z.infer<typeof createProductReviewSchema>['body'];
export type ModerateProductReviewSchemaBody = z.infer<typeof moderateProductReviewSchema>['body'];
export type AdjustStockSchemaBody = z.infer<typeof adjustStockSchema>['body'];
export type BulkProductSchemaBody = z.infer<typeof bulkProductSchema>['body'];
export type ProductMetricsQueryValidated = z.infer<typeof productMetricsSchema>['query'];