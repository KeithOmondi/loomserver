// src/features/catalog/attribute.validator.ts
import { z } from 'zod';
import {
  attributeScopeSchema,
  attributeTypeSchema,
  booleanQuery,
  //depthSchema,
  optionalSortOrderSchema,
  optionalUuid,
  paginationSchema,
  slugSchema,
  sortDirectionSchema,
  sortOrderSchema,
  urlSchema,
  uuidSchema,
} from './common.validator';

// ============================================
// Shared sub-schemas
// ============================================

/**
 * Validation rules for attribute values.
 * Interpreted by `type`:
 *   - text / textarea → min_length, max_length, regex
 *   - number          → min, max, unit
 *   - date            → min, max (ISO date strings, validated at service layer)
 *   - select / multiselect → (validated against options)
 */
export const attributeValidationSchema = z
  .object({
    min_length: z.number().int().min(0).optional(),
    max_length: z.number().int().min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    regex: z.string().max(500).optional(),
    /** ISO unit label: "cm", "kg", "GB" */
    unit: z.string().max(20).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.min_length === undefined ||
      v.max_length === undefined ||
      v.min_length <= v.max_length,
    { message: 'min_length must be <= max_length', path: ['min_length'] },
  )
  .refine(
    (v) => v.min === undefined || v.max === undefined || v.min <= v.max,
    { message: 'min must be <= max', path: ['min'] },
  );

export const attributeOptionInputSchema = z.object({
  value: z
    .string()
    .min(1, 'Option value is required')
    .max(150, 'Option value must be at most 150 characters')
    .trim(),
  slug: slugSchema.optional(),
  swatch: z
    .string()
    .max(50)
    .regex(
      /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
      'Swatch must be a hex color like #fff or #ffffff',
    )
    .optional()
    .nullable(),
  sort_order: optionalSortOrderSchema,
  is_active: z.boolean().optional(),
});

// ============================================
// Attribute Group
// ============================================

export const createAttributeGroupSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).trim(),
    slug: slugSchema.optional(),
    description: z.string().max(500).optional().nullable(),
    sort_order: sortOrderSchema,
  }),
});

export const updateAttributeGroupSchema = z.object({
  params: z.object({ id: uuidSchema }),
  body: z
    .object({
      name: z.string().min(2).max(100).trim().optional(),
      slug: slugSchema.optional(),
      description: z.string().max(500).optional().nullable(),
      sort_order: optionalSortOrderSchema,
    })
    .refine((d) => Object.keys(d).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export const attributeGroupQuerySchema = z.object({
  query: z.object({
    ...paginationSchema,
    search: z.string().min(1).max(100).optional(),
    sort: z.enum(['name', 'sort_order', 'created_at']).default('sort_order'),
    order: sortDirectionSchema.default('asc'),
  }),
});

// ============================================
// Attribute Definition
// ============================================

export const createAttributeSchema = z.object({
  body: z
    .object({
      name: z.string().min(2).max(100).trim(),
      slug: slugSchema.optional(),
      description: z.string().max(1000).optional().nullable(),

      type: attributeTypeSchema,
      scope: attributeScopeSchema.default('global'),

      group_id: optionalUuid,

      is_required: z.boolean().default(false),
      is_filterable: z.boolean().default(true),
      is_variant: z.boolean().default(false),
      is_comparable: z.boolean().default(false),
      is_searchable: z.boolean().default(false),

      validation: attributeValidationSchema.optional(),

      sort_order: sortOrderSchema,

      /** Only valid for select / multiselect. */
      options: z.array(attributeOptionInputSchema).max(500).optional(),
    })
    .refine(
      (d) =>
        d.type === 'select' || d.type === 'multiselect'
          ? true
          : d.options === undefined,
      {
        message: 'options are only allowed for select / multiselect',
        path: ['options'],
      },
    )
    .refine(
      (d) =>
        d.type !== 'select' && d.type !== 'multiselect'
          ? true
          : d.options === undefined || d.options.length > 0,
      {
        message: 'select / multiselect must define at least one option',
        path: ['options'],
      },
    ),
});

export const updateAttributeSchema = z.object({
  params: z.object({ id: uuidSchema }),
  body: z
    .object({
      name: z.string().min(2).max(100).trim().optional(),
      slug: slugSchema.optional(),
      description: z.string().max(1000).optional().nullable(),

      group_id: optionalUuid,

      is_required: z.boolean().optional(),
      is_filterable: z.boolean().optional(),
      is_variant: z.boolean().optional(),
      is_comparable: z.boolean().optional(),
      is_searchable: z.boolean().optional(),

      validation: attributeValidationSchema.optional(),

      sort_order: optionalSortOrderSchema,
      is_active: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export const attributeQuerySchema = z.object({
  query: z.object({
    ...paginationSchema,
    search: z.string().min(1).max(100).optional(),
    type: attributeTypeSchema.optional(),
    scope: attributeScopeSchema.optional(),
    group_id: uuidSchema.optional(),
    is_filterable: booleanQuery(),
    is_variant: booleanQuery(),
    is_required: booleanQuery(),
    is_active: booleanQuery(),
    sort: z
      .enum(['name', 'sort_order', 'created_at'])
      .default('sort_order'),
    order: sortDirectionSchema.default('asc'),
  }),
});

// ============================================
// Attribute Options (bulk + reorder)
// ============================================

export const createAttributeOptionSchema = z.object({
  params: z.object({ attributeId: uuidSchema }),
  body: attributeOptionInputSchema,
});

export const updateAttributeOptionSchema = z.object({
  params: z.object({
    attributeId: uuidSchema,
    optionId: uuidSchema,
  }),
  body: attributeOptionInputSchema
    .partial()
    .refine((d) => Object.keys(d).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export const bulkUpsertAttributeOptionsSchema = z.object({
  params: z.object({ attributeId: uuidSchema }),
  body: z.object({
    options: z.array(attributeOptionInputSchema).min(1).max(500),
    /** Replace all existing options for this attribute. */
    replace_all: z.boolean().default(false),
  }),
});

export const reorderAttributeOptionsSchema = z.object({
  params: z.object({ attributeId: uuidSchema }),
  body: z.object({
    ordered_ids: z.array(uuidSchema).min(1).max(500),
  }),
});

// ============================================
// Attribute Set
// ============================================

export const attributeSetItemInputSchema = z.object({
  attribute_id: uuidSchema,
  is_required_override: z.boolean().optional().nullable(),
  is_filterable_override: z.boolean().optional().nullable(),
  sort_order: optionalSortOrderSchema,
});

export const createAttributeSetSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(100).trim(),
    slug: slugSchema.optional(),
    description: z.string().max(1000).optional().nullable(),
    sort_order: sortOrderSchema,
    is_active: z.boolean().default(true),
    items: z.array(attributeSetItemInputSchema).max(200).optional(),
  }),
});

export const updateAttributeSetSchema = z.object({
  params: z.object({ id: uuidSchema }),
  body: z
    .object({
      name: z.string().min(2).max(100).trim().optional(),
      slug: slugSchema.optional(),
      description: z.string().max(1000).optional().nullable(),
      sort_order: optionalSortOrderSchema,
      is_active: z.boolean().optional(),

      /**
       * Full replacement of items when provided.
       * Omit to leave existing items untouched.
       */
      items: z.array(attributeSetItemInputSchema).max(200).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export const attributeSetQuerySchema = z.object({
  query: z.object({
    ...paginationSchema,
    search: z.string().min(1).max(100).optional(),
    is_active: booleanQuery(),
    /** Only sets containing this attribute. */
    contains_attribute_id: uuidSchema.optional(),
    sort: z
      .enum(['name', 'sort_order', 'created_at'])
      .default('sort_order'),
    order: sortDirectionSchema.default('asc'),
  }),
});

// ============================================
// Attribute Set Items (targeted edits)
// ============================================

export const addAttributeSetItemSchema = z.object({
  params: z.object({ setId: uuidSchema }),
  body: attributeSetItemInputSchema,
});

export const updateAttributeSetItemSchema = z.object({
  params: z.object({
    setId: uuidSchema,
    attributeId: uuidSchema,
  }),
  body: z
    .object({
      is_required_override: z.boolean().optional().nullable(),
      is_filterable_override: z.boolean().optional().nullable(),
      sort_order: optionalSortOrderSchema,
    })
    .refine((d) => Object.keys(d).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export const removeAttributeSetItemSchema = z.object({
  params: z.object({
    setId: uuidSchema,
    attributeId: uuidSchema,
  }),
});

export const reorderAttributeSetItemsSchema = z.object({
  params: z.object({ setId: uuidSchema }),
  body: z.object({
    /** Ordered list of attribute ids as they should appear in the set. */
    ordered_attribute_ids: z.array(uuidSchema).min(1).max(200),
  }),
});

// ============================================
// Bulk status
// ============================================

export const bulkAttributeStatusSchema = z.object({
  body: z.object({
    ids: z.array(uuidSchema).min(1).max(200),
    is_active: z.boolean(),
  }),
});

export const bulkAttributeSetStatusSchema = z.object({
  body: z.object({
    ids: z.array(uuidSchema).min(1).max(200),
    is_active: z.boolean(),
  }),
});

// ============================================
// Inferred types
// ============================================

// Attribute Group
export type CreateAttributeGroupBody = z.infer<typeof createAttributeGroupSchema>['body'];
export type UpdateAttributeGroupBody = z.infer<typeof updateAttributeGroupSchema>['body'];
export type AttributeGroupQuery = z.infer<typeof attributeGroupQuerySchema>['query'];

// Attribute Definition
export type AttributeValidationInput = z.infer<typeof attributeValidationSchema>;
export type AttributeOptionInput = z.infer<typeof attributeOptionInputSchema>;
export type CreateAttributeBody = z.infer<typeof createAttributeSchema>['body'];
export type UpdateAttributeBody = z.infer<typeof updateAttributeSchema>['body'];
export type AttributeQuery = z.infer<typeof attributeQuerySchema>['query'];

// Attribute Options
export type CreateAttributeOptionBody = z.infer<typeof createAttributeOptionSchema>['body'];
export type UpdateAttributeOptionBody = z.infer<typeof updateAttributeOptionSchema>['body'];
export type BulkUpsertAttributeOptionsBody = z.infer<typeof bulkUpsertAttributeOptionsSchema>['body'];
export type ReorderAttributeOptionsBody = z.infer<typeof reorderAttributeOptionsSchema>['body'];

// Attribute Set
export type AttributeSetItemInput = z.infer<typeof attributeSetItemInputSchema>;
export type CreateAttributeSetBody = z.infer<typeof createAttributeSetSchema>['body'];
export type UpdateAttributeSetBody = z.infer<typeof updateAttributeSetSchema>['body'];
export type AttributeSetQuery = z.infer<typeof attributeSetQuerySchema>['query'];

// Attribute Set Items
export type AddAttributeSetItemBody = z.infer<typeof addAttributeSetItemSchema>['body'];
export type UpdateAttributeSetItemBody = z.infer<typeof updateAttributeSetItemSchema>['body'];
export type ReorderAttributeSetItemsBody = z.infer<typeof reorderAttributeSetItemsSchema>['body'];

// Bulk
export type BulkAttributeStatusBody = z.infer<typeof bulkAttributeStatusSchema>['body'];
export type BulkAttributeSetStatusBody = z.infer<typeof bulkAttributeSetStatusSchema>['body'];