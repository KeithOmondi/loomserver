// src/features/catalog/common.validator.ts
import { z } from 'zod';

// ============================================
// Primitives
// ============================================

export const slugSchema = z
  .string()
  .min(1, 'Slug is required')
  .max(150, 'Slug must be at most 150 characters')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug must be lowercase, alphanumeric, and dash-separated',
  );

export const uuidSchema = z.string().uuid('Invalid UUID');

export const optionalUuid = uuidSchema.optional().nullable();

export const urlSchema = z.string().url('Invalid URL').max(2048);

export const optionalUrl = urlSchema.optional().nullable();

// ============================================
// Numbers
// ============================================

export const sortOrderSchema = z.coerce.number().int().min(0).default(0);

export const optionalSortOrderSchema = z.coerce.number().int().min(0).optional();

export const nonNegativeInt = z.coerce.number().int().min(0);

export const positiveInt = z.coerce.number().int().positive();

export const depthSchema = (max = 10) =>
  z.coerce.number().int().min(0).max(max);

// ============================================
// Pagination
// ============================================

export const paginationSchema = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
};

// ============================================
// Boolean query helper (Zod v4-safe)
// ============================================

export const booleanQuery = (defaultValue?: boolean) => {
  const base = z
    .enum(['true', 'false'], {
      error: 'Must be "true" or "false"',
    })
    .transform((v) => v === 'true');

  return defaultValue === undefined ? base.optional() : base.default(defaultValue);
};

// ============================================
// SEO
// ============================================

export const seoSchema = z.object({
  meta_title: z.string().max(255).optional().nullable(),
  meta_description: z.string().max(500).optional().nullable(),
  meta_keywords: z.string().max(500).optional().nullable(),
  canonical_url: urlSchema.optional().nullable(),
  og_image_url: urlSchema.optional().nullable(),
});

export const partialSeoSchema = seoSchema.partial();

// ============================================
// Enums
// ============================================

export const categoryTypeSchema = z.enum([
  'department',
  'category',
  'subcategory',
  'leaf',
]);

export const categoryStatusSchema = z.enum(['active', 'inactive', 'archived']);

export const attributeTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'select',
  'multiselect',
]);

export const attributeScopeSchema = z.enum(['global', 'category']);

export const productStatusSchema = z.enum(['draft', 'published', 'archived']);

export const productVisibilitySchema = z.enum(['visible', 'hidden']);

export const sortDirectionSchema = z.enum(['asc', 'desc']);

// ============================================
// Common params
// ============================================

export const idParamSchema = z.object({
  params: z.object({ id: uuidSchema }),
});

export const slugOrIdParamSchema = z.object({
  params: z.object({
    id: uuidSchema.optional(),
    slug: slugSchema.optional(),
  }),
});