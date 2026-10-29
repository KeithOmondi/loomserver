// src/validators/store.validator.ts

import { z } from 'zod';

// ============================================
// ENUM VALIDATORS
// ============================================

/**
 * Store Status
 * Only ACTIVE, SUSPENDED, CLOSED are used in the new flow.
 * Deprecated values kept for backward compatibility.
 */
const StoreStatusEnum = z.enum([
  'active',           // ✅ Store is live (default after creation)
  'suspended',        // Admin-suspended
  'closed',           // Permanently closed
  // @deprecated
  'draft',
  'pending_approval',
  'rejected',
]);

const StoreTypeEnum = z.enum([
  'physical',
  'digital',
  'services',
  'mixed'
]);

const StoreCategoryEnum = z.enum([
  'electronics',
  'fashion',
  'home_garden',
  'beauty',
  'books',
  'toys',
  'sports',
  'automotive',
  'health',
  'food',
  'services',
  'other'
]);

// ============================================
// COMMON VALIDATION HELPERS
// ============================================

const storeNameField = z
  .string()
  .min(2, 'Store name must be at least 2 characters')
  .max(100, 'Store name cannot exceed 100 characters')
  .regex(/^[a-zA-Z0-9\s\-_&.']+$/, 'Store name contains invalid characters')
  .trim();

const storeSlugField = z
  .string()
  .min(2, 'Store slug must be at least 2 characters')
  .max(100, 'Store slug cannot exceed 100 characters')
  .regex(/^[a-z0-9\-]+$/, 'Store slug can only contain lowercase letters, numbers, and hyphens')
  .trim()
  .optional();

const taglineField = z
  .string()
  .max(200, 'Tagline cannot exceed 200 characters')
  .trim()
  .optional();

const descriptionField = z
  .string()
  .max(5000, 'Description cannot exceed 5000 characters')
  .trim()
  .optional();

const urlField = z
  .string()
  .url('Invalid URL format')
  .max(500, 'URL is too long')
  .optional();

const emailField = z
  .string()
  .email('Enter a valid email address')
  .max(254, 'Email is too long')
  .toLowerCase()
  .trim()
  .optional();

const phoneField = z
  .string()
  .min(10, 'Phone number must be at least 10 digits')
  .max(20, 'Phone number is too long')
  .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format (use E.164 format)')
  .optional();

const locationField = z
  .string()
  .max(255, 'Location is too long')
  .trim()
  .optional();

const countryField = z
  .string()
  .length(2, 'Country must be a 2-letter ISO code')
  .regex(/^[A-Z]{2}$/, 'Country must be a valid ISO 3166-1 alpha-2 code')
  .optional();

const timezoneField = z
  .string()
  .regex(
    /^[A-Za-z]+\/[A-Za-z_]+$/,
    'Invalid timezone format (e.g., America/Los_Angeles)'
  )
  .optional();

const currencyField = z
  .string()
  .length(3, 'Currency must be a 3-letter ISO code')
  .regex(/^[A-Z]{3}$/, 'Currency must be a valid ISO 4217 code')
  .default('USD');

const languageField = z
  .string()
  .length(2, 'Language must be a 2-letter ISO code')
  .regex(/^[a-z]{2}$/, 'Language must be a valid ISO 639-1 code')
  .default('en')
  .optional();

const supportHoursField = z
  .string()
  .max(255, 'Support hours is too long')
  .trim()
  .optional();

// ============================================
// RETURN POLICY SCHEMA
// ============================================

const returnPolicySchema = z
  .object({
    days: z.number().min(0, 'Return days must be at least 0').max(365, 'Return days cannot exceed 365'),
    condition: z.enum(['unused', 'opened', 'any']),
    refund_method: z.enum(['original', 'store_credit']),
    restocking_fee_percent: z.number().min(0, 'Restocking fee cannot be negative').max(100, 'Restocking fee cannot exceed 100%').optional(),
    notes: z.string().max(500, 'Notes are too long').trim().optional(),
  })
  .optional();

// ============================================
// SHIPPING ORIGIN SCHEMA
// ============================================

const shippingOriginSchema = z
  .object({
    country: z.string().length(2, 'Country must be a 2-letter ISO code'),
    state: z.string().max(100, 'State is too long').trim().optional(),
    city: z.string().max(100, 'City is too long').trim().optional(),
    zip_code: z.string().max(20, 'Zip code is too long').trim().optional(),
  })
  .optional();

// ============================================
// SOCIAL LINKS SCHEMA
// ============================================

const socialLinksSchema = z
  .record(
    z.string().regex(/^[a-z_]+$/, 'Social platform name must be lowercase with underscores'),
    z.string().url('Invalid social link URL').max(500, 'Social link is too long')
  )
  .optional()
  .default({});

// ============================================
// CREATE STORE SCHEMA
// ============================================

export const createStoreSchema = z.object({
  body: z.object({
    // === MANDATORY ===
    name: storeNameField,
    category: StoreCategoryEnum,
    type: StoreTypeEnum,

    // === OPTIONAL (Branding) ===
    description: descriptionField,
    tagline: taglineField,
    logo_url: urlField,
    banner_url: urlField,
    cover_image_url: urlField,

    // === OPTIONAL (Contact) ===
    contact_email: emailField,
    contact_phone: phoneField,
    support_hours: supportHoursField,

    // === OPTIONAL (Location) ===
    location: locationField,
    country: countryField,
    timezone: timezoneField,

    // === OPTIONAL (Settings) ===
    sub_categories: z.array(StoreCategoryEnum).max(5, 'Maximum 5 sub-categories allowed').optional(),
    currency: currencyField,
    language: languageField,

    // === OPTIONAL (Policies) ===
    return_policy: returnPolicySchema,
    shipping_origin: shippingOriginSchema,

    // === OPTIONAL (Social) ===
    social_links: socialLinksSchema,
  })
  // === CONDITIONAL VALIDATION ===
  .superRefine((data, ctx) => {
    // Digital stores should not have shipping origin
    if (data.type === 'digital' && data.shipping_origin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Shipping origin is not applicable for digital stores',
        path: ['body', 'shipping_origin'],
      });
    }

    // Physical stores should have shipping origin (recommended)
    if (data.type === 'physical' && !data.shipping_origin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Shipping origin is recommended for physical stores',
        path: ['body', 'shipping_origin'],
        fatal: false, // Warning, not error
      });
    }

    // Return policy sanity check
    if (data.return_policy && data.return_policy.days > 90) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Return window exceeding 90 days may not be supported by all payment providers',
        path: ['body', 'return_policy', 'days'],
        fatal: false,
      });
    }
  }),
});

// ============================================
// UPDATE STORE SCHEMA
// ============================================

export const updateStoreSchema = z.object({
  params: z.object({
    storeId: z.string().uuid('Invalid store ID format'),
  }),
  body: z.object({
    // === Branding ===
    name: storeNameField.optional(),
    description: descriptionField,
    tagline: taglineField,
    logo_url: urlField,
    banner_url: urlField,
    cover_image_url: urlField,

    // === Contact ===
    contact_email: emailField,
    contact_phone: phoneField,
    support_hours: supportHoursField,

    // === Location ===
    location: locationField,
    country: countryField,
    timezone: timezoneField,

    // === Settings ===
    category: StoreCategoryEnum.optional(),
    sub_categories: z.array(StoreCategoryEnum).max(5, 'Maximum 5 sub-categories allowed').optional(),
    currency: currencyField.optional(),
    language: languageField,

    // === Policies ===
    return_policy: returnPolicySchema,
    shipping_origin: shippingOriginSchema,

    // === Social ===
    social_links: socialLinksSchema,
  }),
});

// ============================================
// STORE SUSPENSION SCHEMA (Admin only)
// ============================================

export const suspendStoreSchema = z.object({
  params: z.object({
    storeId: z.string().uuid('Invalid store ID format'),
  }),
  body: z.object({
    reason: z.string().min(1, 'Suspension reason is required').max(500, 'Reason is too long').trim(),
    notify_seller: z.boolean().default(true),
  }),
});

// ============================================
// STORE REINSTATE SCHEMA (Admin only)
// ============================================

export const reinstateStoreSchema = z.object({
  params: z.object({
    storeId: z.string().uuid('Invalid store ID format'),
  }),
  body: z.object({
    reason: z.string().max(500, 'Reason is too long').trim().optional(),
    notify_seller: z.boolean().default(true),
  }),
});

// ============================================
// STORE CLOSE SCHEMA (Seller or Admin)
// ============================================

export const closeStoreSchema = z.object({
  params: z.object({
    storeId: z.string().uuid('Invalid store ID format'),
  }),
  body: z.object({
    reason: z.string().max(500, 'Reason is too long').trim().optional(),
  }),
});

// ============================================
// STORE QUERY SCHEMA
// ============================================

export const getStoresQuerySchema = z.object({
  query: z.object({
    // === Pagination ===
    page: z.coerce.number().min(1, 'Page must be at least 1').optional().default(1),
    limit: z.coerce.number().min(1, 'Limit must be at least 1').max(100, 'Limit must be at most 100').optional().default(20),

    // === Sorting ===
    sortBy: z.enum(['name', 'created_at', 'total_products', 'total_orders', 'average_rating'])
      .optional()
      .default('created_at'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),

    // === Filters ===
    status: z.array(StoreStatusEnum).optional(),
    category: z.array(StoreCategoryEnum).optional(),
    type: z.array(StoreTypeEnum).optional(),
    seller_id: z.string().uuid('Invalid seller ID').optional(),
    is_active: z.coerce.boolean().optional(),
    has_products: z.enum(['true', 'false']).optional()
      .transform(val => val === 'true'),
    min_rating: z.coerce.number().min(0, 'Rating must be at least 0').max(5, 'Rating must be at most 5').optional(),
    max_rating: z.coerce.number().min(0, 'Rating must be at least 0').max(5, 'Rating must be at most 5').optional(),
    country: z.array(countryField).optional(),
    date_from: z.string().datetime({ offset: true }).optional()
      .transform(val => val ? new Date(val) : undefined),
    date_to: z.string().datetime({ offset: true }).optional()
      .transform(val => val ? new Date(val) : undefined),

    // === Search ===
    search: z.string().max(100, 'Search term is too long').trim().optional(),
  }),
});

// ============================================
// STORE METRICS SCHEMA
// ============================================

export const storeMetricsSchema = z.object({
  params: z.object({
    storeId: z.string().uuid('Invalid store ID format'),
  }),
  query: z.object({
    period: z.enum(['today', 'week', 'month', 'year', 'all']).optional().default('month'),
  }),
});

// ============================================
// STORE SLUG CHECK SCHEMA
// ============================================

export const checkStoreSlugSchema = z.object({
  query: z.object({
    slug: storeSlugField,
    exclude: z.string().uuid('Invalid store ID').optional(),
  }),
});

// ============================================
// BULK STORE OPERATIONS SCHEMA (Admin only)
// ============================================

export const bulkUpdateStoresSchema = z.object({
  body: z.object({
    store_ids: z.array(z.string().uuid('Invalid store ID format'))
      .min(1, 'At least one store ID is required')
      .max(50, 'Cannot update more than 50 stores at once'),
    status: StoreStatusEnum,
    reason: z.string().max(500, 'Reason is too long').trim().optional(),
    notify_sellers: z.boolean().default(false),
  }),
});

// ============================================
// TYPE INFERENCE HELPERS
// ============================================

export type CreateStoreInput = z.infer<typeof createStoreSchema>['body'];
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>['body'];
export type SuspendStoreInput = z.infer<typeof suspendStoreSchema>['body'] & z.infer<typeof suspendStoreSchema>['params'];
export type ReinstateStoreInput = z.infer<typeof reinstateStoreSchema>['body'] & z.infer<typeof reinstateStoreSchema>['params'];
export type CloseStoreInput = z.infer<typeof closeStoreSchema>['body'] & z.infer<typeof closeStoreSchema>['params'];
export type GetStoresQuery = z.infer<typeof getStoresQuerySchema>['query'];
export type StoreMetricsQuery = z.infer<typeof storeMetricsSchema>['query'];
export type CheckStoreSlugQuery = z.infer<typeof checkStoreSlugSchema>['query'];
export type BulkUpdateStoresInput = z.infer<typeof bulkUpdateStoresSchema>['body'];

// ============================================
// CENTRALIZED ERROR MESSAGES
// ============================================

export const StoreValidationErrors = {
  // Store errors
  STORE_NOT_FOUND: 'Store not found.',
  STORE_SLUG_TAKEN: 'Store slug is already taken.',
  STORE_NOT_ACTIVE: 'Store is not active.',
  STORE_SUSPENDED: 'Store is suspended.',
  STORE_CLOSED: 'Store is permanently closed.',

  // Permission errors
  STORE_ACCESS_DENIED: 'You do not have access to this store.',
  STORE_UPDATE_DENIED: 'You cannot update this store in its current state.',
  STORE_PRODUCT_ADD_DENIED: 'You cannot add products to this store.',

  // Field errors
  INVALID_STORE_NAME: 'Store name must be at least 2 characters and contain only letters, numbers, spaces, and basic punctuation.',
  INVALID_STORE_SLUG: 'Store slug can only contain lowercase letters, numbers, and hyphens.',
  INVALID_CATEGORY: 'Invalid store category.',
  INVALID_STORE_TYPE: 'Invalid store type.',

  // Policy errors
  RETURN_POLICY_INVALID: 'Return policy must include days, condition, and refund method.',
  SHIPPING_ORIGIN_REQUIRED: 'Shipping origin is required for physical stores.',
  DIGITAL_STORE_NO_SHIPPING: 'Digital stores cannot have shipping origins.',
};

// ============================================
// HELPER: Generate Store Slug from Name
// ============================================

export const generateStoreSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

// ============================================
// HELPER: Check if Store Can Be Edited
// ============================================

/**
 * A store can be edited when it is active (the default state).
 * Suspended/closed stores cannot be edited by the seller.
 */
export const canEditStore = (status: string): boolean => {
  return status === 'active';
};

// ============================================
// HELPER: Check if Store Can Add Products
// ============================================

/**
 * Products can only be added when the store is active.
 * No approval is required (per the single-approval flow).
 */
export const canAddProductsToStore = (status: string, isActive: boolean): boolean => {
  return status === 'active' && isActive === true;
};

// ============================================
// HELPER: Check if Store is Live
// ============================================

/**
 * A store is "live" (visible to customers) when it is active.
 */
export const isStoreLive = (status: string, isActive: boolean): boolean => {
  return status === 'active' && isActive === true;
};

// ============================================
// HELPER: Check if Store Can Process Orders
// ============================================

/**
 * Orders can only be processed when the store is active.
 */
export const canProcessOrders = (status: string, isActive: boolean): boolean => {
  return status === 'active' && isActive === true;
};