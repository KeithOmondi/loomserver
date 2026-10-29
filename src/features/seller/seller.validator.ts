// src/sellers/seller.validator.ts

import { z } from "zod";
import {
  BusinessType,
  KycDocumentType,
  PayoutMethod,
  PayoutSchedule,
  SellerStatus,
  SellerTier,
  SellerSetupStep,
} from "./seller.types";

// ============================================
// ZOD SCHEMAS FROM TS ENUMS (single source of truth)
// ============================================

const SellerStatusEnum = z.nativeEnum(SellerStatus);
const BusinessTypeEnum = z.nativeEnum(BusinessType);
const PayoutMethodEnum = z.nativeEnum(PayoutMethod);
const PayoutScheduleEnum = z.nativeEnum(PayoutSchedule);
const SellerTierEnum = z.nativeEnum(SellerTier);
const KycDocumentTypeEnum = z.nativeEnum(KycDocumentType);
const SellerSetupStepEnum = z.nativeEnum(SellerSetupStep);

// ============================================
// REUSABLE FIELD VALIDATORS
// ============================================

const legalBusinessNameField = z
  .string()
  .min(2, "Legal business name must be at least 2 characters")
  .max(255, "Legal business name cannot exceed 255 characters")
  .regex(/^[a-zA-Z0-9\s\-'&,.()]+$/, "Legal business name contains invalid characters")
  .trim();

const tradingNameField = z
  .string()
  .min(2, "Trading name must be at least 2 characters")
  .max(255, "Trading name cannot exceed 255 characters")
  .regex(/^[a-zA-Z0-9\s\-'&,.()]+$/, "Trading name contains invalid characters")
  .trim();

const countryField = z
  .string()
  .min(2, "Country is required")
  .max(100, "Country name is too long")
  .regex(/^[a-zA-Z\s\-]+$/, "Country contains invalid characters")
  .trim();

const stateField = z
  .string()
  .min(1, "State/Province is required")
  .max(100, "State is too long")
  .regex(/^[a-zA-Z\s\-']+$/, "State contains invalid characters")
  .trim();

const cityField = z
  .string()
  .min(1, "City is required")
  .max(100, "City is too long")
  .regex(/^[a-zA-Z\s\-']+$/, "City contains invalid characters")
  .trim();

const addressField = z
  .string()
  .min(5, "Business address must be at least 5 characters")
  .max(500, "Address is too long")
  .trim();

const phoneField = z
  .string()
  .min(10, "Phone number must be at least 10 digits")
  .max(20, "Phone number is too long")
  .regex(
    /^\+?[0-9]{7,15}$/,
    "Phone number must be 7–15 digits, optionally starting with +"
  )
  .trim();

const emailField = z
  .string()
  .email("Enter a valid email address")
  .max(254, "Email is too long")
  .toLowerCase()
  .trim();

const taxIdField = z
  .string()
  .min(1, "Tax ID is required")
  .max(50, "Tax ID is too long")
  .regex(/^[A-Z0-9\-]+$/, "Tax ID must be alphanumeric with hyphens only")
  .trim();

const registrationNumberField = z
  .string()
  .min(1, "Registration number is required")
  .max(100, "Registration number is too long")
  .regex(/^[A-Z0-9\-]+$/, "Registration number must be alphanumeric with hyphens only")
  .trim();

const currencyField = z
  .string()
  .length(3, "Currency must be a 3-letter ISO code")
  .regex(/^[A-Z]{3}$/, "Currency must be a valid ISO 4217 code")
  .toUpperCase();

const bankAccountNameField = z
  .string()
  .min(2, "Bank account name is required")
  .max(255, "Bank account name is too long")
  .trim();

const bankAccountNumberField = z
  .string()
  .min(4, "Bank account number is required")
  .max(50, "Bank account number is too long")
  .regex(/^[0-9]+$/, "Bank account number must contain only digits")
  .trim();

const bankRoutingNumberField = z
  .string()
  .min(4, "Bank routing number is required")
  .max(50, "Bank routing number is too long")
  .regex(/^[0-9]+$/, "Bank routing number must contain only digits")
  .trim();

const bankNameField = z
  .string()
  .min(2, "Bank name is required")
  .max(255, "Bank name is too long")
  .trim();

// ============================================
// SHARED: Payout-method superRefine
// ============================================

/**
 * Enforces conditional payout fields.
 * Used by both create and update schemas so validation rules never drift.
 */
const validatePayoutMethod = (
  data: {
    payout_method?: PayoutMethod;
    bank_account_name?: string;
    bank_account_number?: string;
    bank_routing_number?: string;
    bank_name?: string;
    bank_country?: string;
    paypal_email?: string;
    mpesa_phone?: string;
  },
  ctx: z.RefinementCtx,
  verb: "creating" | "changing"
) => {
  if (data.payout_method === PayoutMethod.BANK) {
    const bankFields = [
      { field: "bank_account_name" as const, label: "Bank account name" },
      { field: "bank_account_number" as const, label: "Bank account number" },
      { field: "bank_routing_number" as const, label: "Bank routing number" },
      { field: "bank_name" as const, label: "Bank name" },
      { field: "bank_country" as const, label: "Bank country" },
    ];
    for (const { field, label } of bankFields) {
      if (!data[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            verb === "creating"
              ? `${label} is required when payout method is bank`
              : `${label} is required when changing payout method to bank`,
          path: [field],
        });
      }
    }
  }

  if (data.payout_method === PayoutMethod.MPESA && !data.mpesa_phone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        verb === "creating"
          ? "M-Pesa phone number is required when payout method is M-Pesa"
          : "M-Pesa phone number is required when changing payout method to M-Pesa",
      path: ["mpesa_phone"],
    });
  }

  if (data.payout_method === PayoutMethod.PAYPAL && !data.paypal_email) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        verb === "creating"
          ? "PayPal email is required when payout method is PayPal"
          : "PayPal email is required when changing payout method to PayPal",
      path: ["paypal_email"],
    });
  }
};

// ============================================
// CREATE SELLER PROFILE  (POST /sellers/setup — self)
// ============================================

export const createSellerProfileSchema = z.object({
  // No params — seller is derived from req.user.id
  body: z
    .object({
      // ---- Legal & Business (all required for KYC) ----
      legal_business_name: legalBusinessNameField,
      trading_name: tradingNameField,
      business_type: BusinessTypeEnum,
      tax_id: taxIdField,
      registration_number: registrationNumberField,
      country: countryField,
      state: stateField,
      city: cityField,
      business_address: addressField,
      business_phone: phoneField,

      // ---- Payout ----
      payout_method: PayoutMethodEnum,
      bank_account_name: bankAccountNameField.optional(),
      bank_account_number: bankAccountNumberField.optional(),
      bank_routing_number: bankRoutingNumberField.optional(),
      bank_name: bankNameField.optional(),
      bank_country: countryField.optional(),
      paypal_email: emailField.optional(),
      mpesa_phone: phoneField.optional(),

      // ---- Preferences (defaults applied by Zod) ----
      currency: currencyField.optional().default("USD"),
      payout_schedule: PayoutScheduleEnum.optional().default(PayoutSchedule.WEEKLY),
      minimum_payout: z.number().min(0).optional().default(10),
      hold_period_days: z.number().min(0).max(90).optional().default(7),

      // ---- Legal consent ----
      accepted_terms_version: z
        .string()
        .min(1, "Terms acceptance is required")
        .trim(),
      accepted_privacy_version: z
        .string()
        .min(1, "Privacy policy acceptance is required")
        .trim(),
      ip_address: z.string().max(45).trim().optional(),
      user_agent: z.string().max(500).trim().optional(),
    })
    .superRefine((data, ctx) => {
      validatePayoutMethod(data, ctx, "creating");

      if (data.payout_method === PayoutMethod.STRIPE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Stripe Connect setup is handled separately. Please select bank, M-Pesa, or PayPal.",
          path: ["payout_method"],
        });
      }
      if (data.payout_method === PayoutMethod.CRYPTO) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Crypto payouts require additional verification. Please contact support.",
          path: ["payout_method"],
        });
      }
    }),
});

// ============================================
// UPDATE SELLER PROFILE  (PUT /sellers/profile — self)
// ============================================

export const updateSellerProfileSchema = z.object({
  // No params — seller is derived from req.user.id
  body: z
    .object({
      // ---- Legal changes (trigger re-verification) ----
      legal_business_name: legalBusinessNameField.optional(),
      trading_name: tradingNameField.optional(),
      business_type: BusinessTypeEnum.optional(),
      tax_id: taxIdField.optional(),
      registration_number: registrationNumberField.optional(),
      business_address: addressField.optional(),
      business_phone: phoneField.optional(),

      // ---- Operational changes (no re-verification) ----
      country: countryField.optional(),
      state: stateField.optional(),
      city: cityField.optional(),
      currency: currencyField.optional(),

      // ---- Payout changes (trigger bank verification) ----
      payout_method: PayoutMethodEnum.optional(),
      bank_account_name: bankAccountNameField.optional(),
      bank_account_number: bankAccountNumberField.optional(),
      bank_routing_number: bankRoutingNumberField.optional(),
      bank_name: bankNameField.optional(),
      bank_country: countryField.optional(),
      paypal_email: emailField.optional(),
      mpesa_phone: phoneField.optional(),

      // ---- Settings (no verification) ----
      auto_approve_products: z.boolean().optional(),
      enable_negotiation: z.boolean().optional(),
      allow_backorders: z.boolean().optional(),
      allow_preorders: z.boolean().optional(),
      payout_schedule: PayoutScheduleEnum.optional(),
      minimum_payout: z.number().min(0).optional(),
      hold_period_days: z.number().min(0).max(90).optional(),
    })
    .superRefine((data, ctx) => {
      validatePayoutMethod(data, ctx, "changing");
    }),
});

// ============================================
// KYC DOCUMENTS
// ============================================

/**
 * POST /sellers/me/documents — upload one KYC document.
 * Multipart body: `file` (handled by multer), `document_type`, optional `filename`.
 */
export const uploadKycDocumentSchema = z.object({
  // No params — seller is derived from req.user.id
  body: z.object({
    document_type: KycDocumentTypeEnum,
    filename: z
      .string()
      .min(1, "Filename is required")
      .max(255, "Filename is too long")
      .trim(),
  }),
});

/**
 * DELETE /sellers/me/documents/:documentType
 */
export const deleteKycDocumentSchema = z.object({
  // No sellerId — derived from req.user.id
  params: z.object({
    documentType: KycDocumentTypeEnum,
  }),
});

/**
 * PATCH /admin/sellers/:sellerId/documents/:documentType/verify
 * Moderator/admin action.
 */
export const verifyDocumentSchema = z.object({
  params: z.object({
    sellerId: z.string().uuid("Invalid seller ID format"),
    documentType: KycDocumentTypeEnum,
  }),
  body: z
    .object({
      verification_status: z.enum(["verified", "rejected"]),
      rejection_reason: z.string().max(500).trim().optional(),
    })
    .superRefine((data, ctx) => {
      if (data.verification_status === "rejected" && !data.rejection_reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Rejection reason is required when rejecting a document",
          path: ["rejection_reason"],
        });
      }
    }),
});

// ============================================
// STATUS / PROGRESS  (self routes)
// ============================================

/**
 * GET /sellers/profile/status — self.
 * No params, no query.
 */
export const sellerStatusCheckSchema = z.object({
  // No params — derived from req.user.id
});

/**
 * GET /sellers/profile/progress — self.
 */
export const sellerSetupProgressSchema = z.object({
  // No params — derived from req.user.id
});

/**
 * PUT /sellers/profile/setup-step — self (optional endpoint).
 */
export const updateSellerSetupStepSchema = z.object({
  // No params — derived from req.user.id
  body: z.object({
    currentStep: SellerSetupStepEnum,
    completedSteps: z
      .array(z.enum(["basic_info", "business_details", "kyc_documents", "payment_setup"]))
      .optional(),
  }),
});

/**
 * GET /sellers/metrics — self.
 */
export const sellerMetricsSchema = z.object({
  // No params — derived from req.user.id
  query: z.object({
    period: z
      .enum(["today", "week", "month", "year", "all"])
      .optional()
      .default("month"),
  }),
});

// ============================================
// ADMIN SCHEMAS  (routes with :sellerId)
// ============================================

/**
 * PUT /admin/sellers/:sellerId/verify
 */
export const verifySellerSchema = z.object({
  params: z.object({
    sellerId: z.string().uuid("Invalid seller ID format"),
  }),
  body: z
    .object({
      status: z.enum(["verified", "rejected"]),
      reason: z.string().max(500).trim().optional(),
      reviewer_notes: z.string().max(1000).trim().optional(),
      kyc_expiry_date: z
        .string()
        .datetime({ offset: true })
        .optional()
        .transform((val) => (val ? new Date(val) : undefined)),
    })
    .superRefine((data, ctx) => {
      if (data.status === "rejected" && !data.reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Rejection reason is required when rejecting a seller",
          path: ["reason"],
        });
      }
    }),
});

/**
 * POST /admin/sellers/:sellerId/suspend
 */
export const suspendSellerSchema = z.object({
  params: z.object({
    sellerId: z.string().uuid("Invalid seller ID format"),
  }),
  body: z.object({
    reason: z.string().min(1).max(500).trim(),
    notes: z.string().max(1000).trim().optional(),
    suspend_stores: z.boolean().default(true),
    notify_seller: z.boolean().default(true),
  }),
});

/**
 * POST /admin/sellers/:sellerId/reinstate
 */
export const reinstateSellerSchema = z.object({
  params: z.object({
    sellerId: z.string().uuid("Invalid seller ID format"),
  }),
  body: z.object({
    reason: z.string().max(500).trim().optional(),
    notes: z.string().max(1000).trim().optional(),
    reinstate_stores: z.boolean().default(true),
    notify_seller: z.boolean().default(true),
  }),
});

/**
 * PUT /admin/sellers/:sellerId/tier
 */
export const updateSellerTierSchema = z.object({
  params: z.object({
    sellerId: z.string().uuid("Invalid seller ID format"),
  }),
  body: z.object({
    tier: SellerTierEnum,
    reason: z.string().min(1).max(500).trim(),
    effective_from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .transform((val) => (val ? new Date(val) : undefined)),
    max_stores_allowed: z.number().min(1).max(100).optional(),
    max_products_per_store: z.number().min(1).max(10000).optional(),
  }),
});

/**
 * GET /admin/sellers/:sellerId
 */
export const getSellerByIdSchema = z.object({
  params: z.object({
    sellerId: z.string().uuid("Invalid seller ID format"),
  }),
});

// ============================================
// QUERY SCHEMAS
// ============================================

/**
 * GET /admin/sellers
 */
export const getSellersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().min(1).optional().default(1),
    limit: z.coerce.number().min(1).max(100).optional().default(20),
    sortBy: z
      .enum(["rating", "total_orders", "created_at", "fulfillment_rate", "revenue"])
      .optional()
      .default("created_at"),
    sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),

    status: z
      .union([SellerStatusEnum, z.array(SellerStatusEnum)])
      .optional()
      .transform((val) => (val ? (Array.isArray(val) ? val : [val]) : undefined)),
    country: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((val) => (val ? (Array.isArray(val) ? val : [val]) : undefined)),
    tier: z
      .union([SellerTierEnum, z.array(SellerTierEnum)])
      .optional()
      .transform((val) => (val ? (Array.isArray(val) ? val : [val]) : undefined)),
    business_type: z
      .union([BusinessTypeEnum, z.array(BusinessTypeEnum)])
      .optional()
      .transform((val) => (val ? (Array.isArray(val) ? val : [val]) : undefined)),
    has_stores: z
      .enum(["true", "false"])
      .optional()
      .transform((val) => val === "true"),
    min_rating: z.coerce.number().min(0).max(5).optional(),
    max_rating: z.coerce.number().min(0).max(5).optional(),
    date_from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .transform((val) => (val ? new Date(val) : undefined)),
    date_to: z
      .string()
      .datetime({ offset: true })
      .optional()
      .transform((val) => (val ? new Date(val) : undefined)),
    search: z.string().max(100).trim().optional(),
    min_revenue: z.coerce.number().min(0).optional(),
    max_revenue: z.coerce.number().min(0).optional(),
  }),
});

/**
 * POST /admin/sellers/bulk-status
 */
export const bulkUpdateSellerStatusSchema = z.object({
  body: z.object({
    seller_ids: z
      .array(z.string().uuid("Invalid seller ID format"))
      .min(1, "At least one seller ID is required")
      .max(100, "Cannot update more than 100 sellers at once"),
    status: SellerStatusEnum,
    reason: z.string().max(500).trim().optional(),
    notify_sellers: z.boolean().default(false),
  }),
});

// ============================================
// HELPERS (used by seller.service.ts)
// ============================================

export function getTierLimits(tier: SellerTier) {
  const limits = {
    [SellerTier.BASIC]: {
      max_stores_allowed: 1,
      max_products_per_store: 100,
      max_orders_per_month: 500,
      commission_rate: 0.15,
      hold_period_days: 7,
      support_level: "standard",
    },
    [SellerTier.PRO]: {
      max_stores_allowed: 5,
      max_products_per_store: 1000,
      max_orders_per_month: 5000,
      commission_rate: 0.1,
      hold_period_days: 3,
      support_level: "priority",
    },
    [SellerTier.ENTERPRISE]: {
      max_stores_allowed: 999,
      max_products_per_store: 10000,
      max_orders_per_month: 999999,
      commission_rate: 0.05,
      hold_period_days: 1,
      support_level: "dedicated",
    },
  };
  return limits[tier];
}

// Minimal shape to avoid a circular import with seller.service.ts
interface UpdateSellerInputLike {
  legal_business_name?: unknown;
  business_type?: unknown;
  tax_id?: unknown;
  registration_number?: unknown;
  business_address?: unknown;
  business_phone?: unknown;
  payout_method?: unknown;
  bank_account_name?: unknown;
  bank_account_number?: unknown;
  bank_routing_number?: unknown;
  bank_name?: unknown;
  bank_country?: unknown;
  paypal_email?: unknown;
  mpesa_phone?: unknown;
}

export function requiresKycVerification(input: UpdateSellerInputLike): boolean {
  const sensitiveFields: (keyof UpdateSellerInputLike)[] = [
    "legal_business_name",
    "business_type",
    "tax_id",
    "registration_number",
    "business_address",
    "business_phone",
    "payout_method",
    "bank_account_name",
    "bank_account_number",
    "bank_routing_number",
    "bank_name",
    "bank_country",
    "paypal_email",
    "mpesa_phone",
  ];
  return sensitiveFields.some(
    (field) => input[field] !== undefined && input[field] !== null
  );
}

// ============================================
// TYPE INFERENCE HELPERS
// ============================================

export type CreateSellerInput = z.infer<typeof createSellerProfileSchema>["body"];
export type UpdateSellerInput = z.infer<typeof updateSellerProfileSchema>["body"];

// Self routes — no params
export type UploadKycDocumentInput = z.infer<typeof uploadKycDocumentSchema>["body"];
export type DeleteKycDocumentInput = z.infer<typeof deleteKycDocumentSchema>["params"];
export type SellerMetricsQuery = z.infer<typeof sellerMetricsSchema>["query"];
export type UpdateSellerSetupStepInput = z.infer<
  typeof updateSellerSetupStepSchema
>["body"];

// Admin routes — params + body
export type VerifyDocumentInput = z.infer<typeof verifyDocumentSchema>["body"] &
  z.infer<typeof verifyDocumentSchema>["params"];
export type VerifySellerInput = z.infer<typeof verifySellerSchema>["body"] &
  z.infer<typeof verifySellerSchema>["params"];
export type SuspendSellerInput = z.infer<typeof suspendSellerSchema>["body"] &
  z.infer<typeof suspendSellerSchema>["params"];
export type ReinstateSellerInput = z.infer<typeof reinstateSellerSchema>["body"] &
  z.infer<typeof reinstateSellerSchema>["params"];
export type UpdateSellerTierInput = z.infer<typeof updateSellerTierSchema>["body"] &
  z.infer<typeof updateSellerTierSchema>["params"];
export type GetSellerByIdInput = z.infer<typeof getSellerByIdSchema>["params"];
export type GetSellersQuery = z.infer<typeof getSellersQuerySchema>["query"];
export type BulkUpdateSellerStatusInput = z.infer<
  typeof bulkUpdateSellerStatusSchema
>["body"];

// ============================================
// CENTRALIZED ERROR MESSAGES
// ============================================

export const SellerValidationErrors = {
  SELLER_NOT_ACTIVE: "Seller account is not active. Please complete your verification.",
  SELLER_SUSPENDED: "Seller account is suspended. Please contact support.",
  SELLER_KYC_EXPIRED: "Seller KYC has expired. Please update your verification documents.",
  SELLER_KYC_PENDING:
    "Seller has a pending KYC update. Complete verification before making changes.",
  SELLER_MAX_STORES_EXCEEDED: "Maximum store limit reached for this seller tier.",
  SELLER_KYC_INCOMPLETE:
    "All required KYC documents must be uploaded before verification.",

  INVALID_BUSINESS_NAME:
    "Business name must be at least 2 characters and contain only letters, numbers, spaces, and basic punctuation.",
  INVALID_COUNTRY: "Country must be a valid country name.",
  INVALID_PHONE: "Phone number must be 7–15 digits, optionally starting with +.",
  INVALID_TAX_ID: "Tax ID must be alphanumeric with hyphens only.",
  INVALID_CURRENCY: "Currency must be a valid 3-letter ISO currency code.",
  INVALID_REGISTRATION_NUMBER:
    "Registration number must be alphanumeric with hyphens only.",

  PAYOUT_METHOD_REQUIRED: "Payout method is required.",
  BANK_FIELDS_REQUIRED:
    "Bank account name, number, routing number, bank name, and bank country are required for bank payouts.",
  MPESA_PHONE_REQUIRED: "M-Pesa phone number is required for M-Pesa payouts.",
  PAYPAL_EMAIL_REQUIRED: "PayPal email is required for PayPal payouts.",

  DOCUMENT_TYPE_NOT_REQUIRED:
    "This document type is not required for your business type.",
  DOCUMENT_ALREADY_UPLOADED:
    "This document has already been uploaded. Delete it first to re-upload.",
  DOCUMENT_NOT_FOUND: "Document not found.",
  DOCUMENT_VERIFICATION_FAILED: "Document verification failed.",
  REJECTION_REASON_REQUIRED:
    "Rejection reason is required when rejecting a document.",
};