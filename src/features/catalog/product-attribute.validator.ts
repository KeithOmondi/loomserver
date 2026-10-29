// src/features/catalog/product-attribute.validator.ts
import { z } from 'zod';
import { uuidSchema } from './common.validator';

// ============================================
// Value input (write side — used by product create/update)
// ============================================

/**
 * One attribute value for a product. Exactly one value_* field must be
 * provided, chosen based on the attribute's `type`:
 *
 *   text / textarea → value_text
 *   number          → value_number
 *   boolean         → value_boolean
 *   date            → value_date
 *   select          → value_option_id
 *   multiselect     → value_option_ids
 *
 * The service layer validates the chosen field matches the attribute type.
 */
export const productAttributeInputSchema = z
  .object({
    attribute_id: uuidSchema,

    value_text: z.string().max(5000).optional(),
    value_number: z.number().finite().optional(),
    value_boolean: z.boolean().optional(),
    value_date: z.coerce.date().optional(),
    value_option_id: uuidSchema.optional(),
    value_option_ids: z.array(uuidSchema).min(1).max(100).optional(),
  })
  .refine(
    (v) => {
      const provided = [
        v.value_text !== undefined,
        v.value_number !== undefined,
        v.value_boolean !== undefined,
        v.value_date !== undefined,
        v.value_option_id !== undefined,
        v.value_option_ids !== undefined,
      ].filter(Boolean).length;
      return provided === 1;
    },
    {
      message:
        'Exactly one value field must be provided (value_text, value_number, value_boolean, value_date, value_option_id, or value_option_ids)',
    },
  );

export type ProductAttributeInput = z.infer<typeof productAttributeInputSchema>;

/** Bulk payload used on product create/update. */
export const productAttributesInputSchema = z
  .array(productAttributeInputSchema)
  .max(200)
  .refine(
    (arr) => {
      const ids = arr.map((a) => a.attribute_id);
      return new Set(ids).size === ids.length;
    },
    { message: 'Duplicate attribute_id in attributes array' },
  );

// ============================================
// Filter union (read side — powers faceted search)
// ============================================

/**
 * Individual filter clauses. Each variant maps to a specific SQL strategy:
 *
 *   select       → WHERE pav.value_option_id IN (option_ids)
 *   multiselect  → WHERE pav.value_option_ids && option_ids   (array overlap)
 *                  or        pav.value_option_ids @> option_ids (contains all)
 *   number       → WHERE pav.value_number BETWEEN min AND max
 *   boolean      → WHERE pav.value_boolean = value
 *   date         → WHERE pav.value_date BETWEEN from AND to
 *   text         → WHERE pav.value_text ILIKE '%query%'
 *   exists       → WHERE pav.id IS [NOT] NULL
 */
export const attributeFilterSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('select'),
    slug: z.string().min(1).max(150),
    /** Option slugs. */
    values: z.array(z.string().min(1).max(150)).min(1).max(100),
  }),
  z.object({
    type: z.literal('multiselect'),
    slug: z.string().min(1).max(150),
    values: z.array(z.string().min(1).max(150)).min(1).max(100),
    /** "any" = overlap, "all" = contains. Defaults to "any". */
    match: z.enum(['any', 'all']).default('any'),
  }),
  z.object({
    type: z.literal('number'),
    slug: z.string().min(1).max(150),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }).refine((v) => v.min !== undefined || v.max !== undefined, {
    message: 'number filter requires min or max',
  }),
  z.object({
    type: z.literal('boolean'),
    slug: z.string().min(1).max(150),
    value: z.boolean(),
  }),
  z.object({
    type: z.literal('date'),
    slug: z.string().min(1).max(150),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }).refine((v) => v.from !== undefined || v.to !== undefined, {
    message: 'date filter requires from or to',
  }),
  z.object({
    type: z.literal('text'),
    slug: z.string().min(1).max(150),
    query: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal('exists'),
    slug: z.string().min(1).max(150),
    exists: z.boolean(),
  }),
]);

export type AttributeFilter = z.infer<typeof attributeFilterSchema>;

// ============================================
// Filter input — accepts typed array OR legacy record
// ============================================

/**
 * Legacy record form (kept for URL-param friendliness):
 *
 *   { brand: 'apple', color: ['red', 'blue'], price: { min: 100, max: 500 } }
 *
 * The service layer normalizes this into AttributeFilter[] using the
 * attribute slug → type mapping from the DB.
 */
export const attributeFilterRecordSchema = z.record(
  z.string().min(1).max(150),
  z.union([
    z.string(),
    z.array(z.string()),
    z.object({
      min: z.coerce.number().finite().optional(),
      max: z.coerce.number().finite().optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
    z.boolean(),
  ]),
);

export type AttributeFilterRecord = z.infer<typeof attributeFilterRecordSchema>;

/**
 * The public filter payload accepted by product queries.
 * Either a typed array (preferred) or a record (legacy / URL-driven).
 */
export const attributeFilterInputSchema = z.union([
  z.array(attributeFilterSchema).max(50),
  attributeFilterRecordSchema,
]);

export type AttributeFilterInput = z.infer<typeof attributeFilterInputSchema>;

// ============================================
// Response shape (read side)
// ============================================

export const productAttributeValueSchema = z.object({
  attribute_id: uuidSchema,
  attribute_slug: z.string(),
  attribute_name: z.string(),
  attribute_type: z.enum([
    'text',
    'textarea',
    'number',
    'boolean',
    'date',
    'select',
    'multiselect',
  ]),
  unit: z.string().nullable().optional(),

  value_text: z.string().nullable(),
  value_number: z.number().nullable(),
  value_boolean: z.boolean().nullable(),
  value_date: z.date().nullable(),
  value_option_id: uuidSchema.nullable(),
  value_option_ids: z.array(uuidSchema).nullable(),

  /** Resolved option details for select / multiselect. */
  option: z
    .object({
      id: uuidSchema,
      value: z.string(),
      slug: z.string(),
      swatch: z.string().nullable(),
    })
    .nullable()
    .optional(),
  options: z
    .array(
      z.object({
        id: uuidSchema,
        value: z.string(),
        slug: z.string(),
        swatch: z.string().nullable(),
      }),
    )
    .nullable()
    .optional(),
});

export type ProductAttributeValueResponse = z.infer<typeof productAttributeValueSchema>;