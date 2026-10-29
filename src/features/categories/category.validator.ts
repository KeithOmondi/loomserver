// src/features/catalog/category.validator.ts
import { z } from 'zod';
import {
  booleanQuery,
  categoryStatusSchema,
  categoryTypeSchema,
  depthSchema,
  optionalSortOrderSchema,
  optionalUuid,
  paginationSchema,
  partialSeoSchema,
  slugSchema,
  sortDirectionSchema,
  sortOrderSchema,
  urlSchema,
  uuidSchema,
} from '../catalog/common.validator';

// ============================================
// Params
// ============================================

export const categoryIdParamSchema = z.object({
  params: z.object({ id: uuidSchema }),
});

export const categorySlugParamSchema = z.object({
  params: z.object({ slug: slugSchema }),
});

/**
 * Same as categoryIdParamSchema, but for routes mounted under a
 * different param name (e.g. `/categories/:categoryId/attributes`).
 */
export const categoryIdParamSchemaAlt = z.object({
  params: z.object({ categoryId: uuidSchema }),
});

// ============================================
// Create
// ============================================

export const createCategorySchema = z.object({
  body: z.object({
    parent_id: optionalUuid,

    name: z
      .string()
      .min(2, 'Category name must be at least 2 characters')
      .max(100, 'Category name must be at most 100 characters')
      .trim(),

    slug: slugSchema.optional(),

    description: z.string().max(1000).optional().nullable(),

    /** Inferred from parent depth if omitted (service layer). */
    type: categoryTypeSchema.optional(),

    image_url: urlSchema.optional().nullable(),
    icon: z.string().max(100).optional().nullable(),

    sort_order: sortOrderSchema,

    status: categoryStatusSchema.default('active'),
    is_featured: z.boolean().default(false),

    seo: partialSeoSchema.optional(),
  }),
});

export type CreateCategoryBody = z.infer<typeof createCategorySchema>['body'];

// ============================================
// Update
// ============================================

export const updateCategorySchema = z.object({
  params: z.object({ id: uuidSchema }),
  body: z
    .object({
      parent_id: optionalUuid,

      name: z.string().min(2).max(100).trim().optional(),
      slug: slugSchema.optional(),

      description: z.string().max(1000).optional().nullable(),

      type: categoryTypeSchema.optional(),

      image_url: urlSchema.optional().nullable(),
      icon: z.string().max(100).optional().nullable(),

      sort_order: optionalSortOrderSchema,

      status: categoryStatusSchema.optional(),
      is_featured: z.boolean().optional(),

      seo: partialSeoSchema.optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export type UpdateCategoryBody = z.infer<typeof updateCategorySchema>['body'];

// ============================================
// Query (list)
// ============================================

export const categoryQuerySchema = z.object({
  query: z
    .object({
      ...paginationSchema,

      search: z.string().min(1).max(100).optional(),

      parent_id: uuidSchema.optional(),
      /** Query root-only categories (parent_id IS NULL). */
      parent_id_is_null: booleanQuery(),

      /** Filter by node role. */
      type: categoryTypeSchema.optional(),

      status: categoryStatusSchema.optional(),

      is_featured: booleanQuery(),
      is_leaf: booleanQuery(),

      /** Return the subtree under `parent_id` (uses ltree). */
      include_descendants: booleanQuery(),

      /** Cap the tree walk depth. */
      depth_max: depthSchema(10).optional(),

      sort: z
        .enum(['name', 'sort_order', 'created_at', 'product_count'])
        .default('sort_order'),
      order: sortDirectionSchema.default('asc'),
    })
    .refine(
      (q) => !q.include_descendants || q.parent_id !== undefined,
      {
        message: 'include_descendants requires parent_id',
        path: ['include_descendants'],
      },
    )
    .refine(
      (q) => !(q.parent_id && q.parent_id_is_null === true),
      {
        message: 'parent_id and parent_id_is_null are mutually exclusive',
        path: ['parent_id'],
      },
    ),
});

export type CategoryQuery = z.infer<typeof categoryQuerySchema>['query'];

// ============================================
// Tree endpoint
// ============================================

export const categoryTreeQuerySchema = z.object({
  query: z.object({
    root_id: uuidSchema.optional(),
    depth_max: depthSchema(10).default(5),
    status: categoryStatusSchema.default('active'),
    include_product_count: booleanQuery(true),
  }),
});

export type CategoryTreeQuery = z.infer<typeof categoryTreeQuerySchema>['query'];

// ============================================
// Move / reorder
// ============================================

export const moveCategorySchema = z.object({
  params: z.object({ id: uuidSchema }),
  body: z.object({
    /**
     * New parent. Must be explicitly provided:
     *   - a UUID → move under that category
     *   - null   → promote to root
     */
    parent_id: z.string().uuid('Invalid parent category ID').nullable(),
    /** Optional re-sequencing under the new parent. */
    sort_order: optionalSortOrderSchema,
  }),
});

export type MoveCategoryBody = z.infer<typeof moveCategorySchema>['body'];

export const reorderCategoriesSchema = z.object({
  body: z.object({
    /** Siblings under this parent. Null = root-level siblings. */
    parent_id: optionalUuid,
    ordered_ids: z.array(uuidSchema).min(1).max(500),
  }),
});

export type ReorderCategoriesBody = z.infer<typeof reorderCategoriesSchema>['body'];

// ============================================
// Bulk operations
// ============================================

export const bulkCategoryStatusSchema = z.object({
  body: z.object({
    ids: z.array(uuidSchema).min(1).max(200),
    status: categoryStatusSchema,
  }),
});

export type BulkCategoryStatusBody = z.infer<typeof bulkCategoryStatusSchema>['body'];

export const bulkCategoryDeleteSchema = z.object({
  body: z.object({
    ids: z.array(uuidSchema).min(1).max(200),
    /** Refuse to delete if any category has children or products. */
    force: z.boolean().default(false),
  }),
});

export type BulkCategoryDeleteBody = z.infer<typeof bulkCategoryDeleteSchema>['body'];

// ============================================
// Response schemas
// ============================================

export const categorySeoResponseSchema = z.object({
  meta_title: z.string().nullable(),
  meta_description: z.string().nullable(),
  meta_keywords: z.string().nullable(),
  canonical_url: z.string().nullable(),
  og_image_url: z.string().nullable(),
});

export const categoryListItemSchema = z.object({
  id: uuidSchema,
  parent_id: uuidSchema.nullable(),

  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),

  path: z.string(),
  depth: z.number().int(),
  is_leaf: z.boolean(),
  type: categoryTypeSchema,

  image_url: z.string().nullable(),
  icon: z.string().nullable(),

  sort_order: z.number().int(),
  status: categoryStatusSchema,
  is_featured: z.boolean(),

  product_count: z.number().int(),
  child_count: z.number().int(),

  created_at: z.date(),
  updated_at: z.date(),
});

export const categoryDetailResponseSchema = categoryListItemSchema.extend({
  seo: categorySeoResponseSchema,
  created_by: uuidSchema.nullable(),
});

export const categoryTreeNodeSchema: z.ZodType<any> = z.lazy(() =>
  categoryListItemSchema.extend({
    children: z.array(categoryTreeNodeSchema),
    full_path: z.string(),
  }),
);

export type CategoryListItem = z.infer<typeof categoryListItemSchema>;
export type CategoryDetailResponse = z.infer<typeof categoryDetailResponseSchema>;