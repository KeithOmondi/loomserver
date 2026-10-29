// src/validators/moderator.validator.ts

import { z } from "zod";

// ============================================
// Common Validation Helpers
// ============================================

const idField = z.string().uuid("Invalid ID format");
const optionalIdField = z.string().uuid("Invalid ID format").optional();

const reasonField = z
  .string()
  .max(500, "Reason must be at most 500 characters")
  .trim()
  .optional();

const notesField = z
  .string()
  .max(1000, "Notes must be at most 1000 characters")
  .trim()
  .optional();

const moderationTargetEnum = z.enum(
  ["store", "product", "seller", "review", "content", "dispute"],
  { message: "Invalid target type" }
);

const moderationStatusEnum = z.enum(
  [
    "pending",
    "in_review",
    "approved",
    "rejected",
    "flagged",
    "suspended",
    "removed",
    "resolved",
  ],
  { message: "Invalid moderation status" }
);

const moderationPriorityEnum = z.enum(
  ["low", "medium", "high", "urgent"],
  { message: "Priority must be one of: low, medium, high, urgent" }
);

const moderationActionEnum = z.enum(
  ["approved", "rejected", "flagged", "suspended", "removed", "resolved"],
  { message: "Invalid action" }
);

/**
 * KYC document types — mirrors `KycDocumentType` from
 * `src/sellers/seller.types.ts`. Kept inline because this file
 * runs in a context where importing TS enums is unnecessary.
 */
const kycDocumentTypeEnum = z.enum(
  [
    "business_registration",
    "business_license",
    "tax_certificate",
    "id_front",
    "id_back",
    "selfie",
    "proof_of_address",
    "bank_statement",
  ],
  { message: "Invalid KYC document type" }
);

/**
 * Seller verification statuses — the values the UI's filter dropdown
 * sends (plus an empty string for "no filter").
 */
const sellerVerificationStatusEnum = z.enum(
  [
    "pending",
    "verified",
    "rejected",
    "suspended",
    "kyc_submitted",
    "kyc_update_pending",
  ],
  { message: "Invalid seller verification status" }
);

// ============================================
// Store Review Schema
// ============================================

export const reviewStoreSchema = z.object({
  params: z.object({
    storeId: idField,
  }),
  body: z.object({
    approved: z.boolean({ message: "Approval status is required" }),
    rejection_reason: reasonField,
    notes: notesField,
  }),
});

// ============================================
// Product Review Schema
// ============================================

export const reviewProductSchema = z.object({
  params: z.object({
    productId: idField,
  }),
  body: z.object({
    approved: z.boolean({ message: "Approval status is required" }),
    rejection_reason: reasonField,
    notes: notesField,
  }),
});

// ============================================
// Seller Verification Schema (whole-seller override)
// ============================================

export const verifySellerSchema = z.object({
  params: z.object({
    sellerId: idField,
  }),
  body: z.object({
    verified: z.boolean({ message: "Verification status is required" }),
    reason: reasonField,
  }),
});

// ============================================
// Verify Seller KYC Document Schema
// ============================================
//
// PATCH /sellers/admin/sellers/:sellerId/documents/:documentType/verify
// Moderator/admin only. Mirrors `seller.validator.ts → verifyDocumentSchema`.

export const verifySellerDocumentSchema = z.object({
  params: z.object({
    sellerId: idField,
    documentType: kycDocumentTypeEnum,
  }),
  body: z
    .object({
      verification_status: z.enum(["verified", "rejected"], {
        message: "verification_status must be 'verified' or 'rejected'",
      }),
      rejection_reason: z
        .string()
        .max(500, "Rejection reason must be at most 500 characters")
        .trim()
        .optional(),
    })
    .superRefine((data, ctx) => {
      if (
        data.verification_status === "rejected" &&
        !data.rejection_reason
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Rejection reason is required when rejecting a document",
          path: ["rejection_reason"],
        });
      }
    }),
});

// ============================================
// Content Moderation Schema
// ============================================

export const moderateContentSchema = z.object({
  params: z.object({
    contentId: idField,
  }),
  body: z.object({
    action: z.enum(["approve", "remove", "flag"], {
      message: "Action must be one of: approve, remove, flag",
    }),
    reason: reasonField,
  }),
});

// ============================================
// Dispute Resolution Schema
// ============================================

export const resolveDisputeSchema = z.object({
  params: z.object({
    disputeId: idField,
  }),
  body: z.object({
    resolution: z.enum(["refund", "replacement", "dismiss", "escalate"], {
      message:
        "Resolution must be one of: refund, replacement, dismiss, escalate",
    }),
    refund_amount: z
      .number()
      .min(0, "Refund amount must be at least 0")
      .optional(),
    notes: notesField,
  }),
});

// ============================================
// Bulk Moderation Schema
// ============================================

export const bulkModerationSchema = z.object({
  body: z.object({
    target_type: moderationTargetEnum,
    target_ids: z.array(idField).min(1, "At least one target ID is required"),
    action: moderationActionEnum,
    notes: notesField,
  }),
});

// ============================================
// Moderation Filters Schema
// ============================================

export const moderationFiltersSchema = z.object({
  query: z.object({
    target_type: moderationTargetEnum.optional(),
    status: moderationStatusEnum.optional(),
    priority: moderationPriorityEnum.optional(),
    search: z.string().max(100, "Search term is too long").trim().optional(),
    page: z.coerce.number().min(1, "Page must be at least 1").optional().default(1),
    limit: z.coerce
      .number()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .optional()
      .default(20),
    sortBy: z
      .enum(["created_at", "priority", "status", "updated_at"])
      .optional()
      .default("created_at"),
    sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
    date_from: z.string().datetime().optional(),
    date_to: z.string().datetime().optional(),
  }),
});

// ============================================
// Moderation History Filters Schema
// ============================================

export const moderationHistoryFiltersSchema = z.object({
  query: z.object({
    moderator_id: z.string().uuid("Invalid moderator ID").optional(),
    target_type: moderationTargetEnum.optional(),
    action: moderationActionEnum.optional(),
    page: z.coerce.number().min(1, "Page must be at least 1").optional().default(1),
    limit: z.coerce
      .number()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .optional()
      .default(20),
  }),
});

// ============================================
// Priority Update Schema
// ============================================

export const updatePrioritySchema = z.object({
  params: z.object({
    itemId: idField,
  }),
  body: z.object({
    priority: moderationPriorityEnum,
  }),
});

// ============================================
// Note Update Schema
// ============================================

export const updateModerationNoteSchema = z.object({
  params: z.object({
    itemId: idField,
  }),
  body: z.object({
    notes: z
      .string()
      .min(1, "Notes are required")
      .max(1000, "Notes must be at most 1000 characters")
      .trim(),
  }),
});

// ============================================
// Get Pending Stores Query Schema
// ============================================

export const getPendingStoresQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().min(1, "Page must be at least 1").optional().default(1),
    limit: z.coerce
      .number()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .optional()
      .default(20),
    search: z.string().max(100, "Search term is too long").trim().optional(),
  }),
});

// ============================================
// Get All Stores Query Schema
// ============================================
//
// GET /moderator/stores
// Returns stores of any status; optional single-status filter.
// When no status is provided, returns ALL stores (pending + approved +
// rejected + suspended + in_review).

export const getAllStoresQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().min(1, "Page must be at least 1").optional().default(1),
    limit: z.coerce
      .number()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .optional()
      .default(20),
    search: z.string().max(100, "Search term is too long").trim().optional(),
    /**
     * Optional status filter. Accepts any valid moderation status,
     * or an empty string (treated as "no filter" / all statuses).
     */
    status: z
      .union([moderationStatusEnum, z.literal("")])
      .optional(),
  }),
});

// ============================================
// Get Pending Sellers Query Schema
// ============================================

export const getPendingSellersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().min(1, "Page must be at least 1").optional().default(1),
    limit: z.coerce
      .number()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .optional()
      .default(20),
    search: z.string().max(100, "Search term is too long").trim().optional(),
  }),
});

// ============================================
// Get All Sellers Query Schema (NEW)
// ============================================
//
// GET /moderator/sellers
// Returns sellers of any status; optional single-status filter.
// When no status is provided, returns ALL sellers (pending + verified +
// rejected + suspended).

export const getAllSellersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().min(1, "Page must be at least 1").optional().default(1),
    limit: z.coerce
      .number()
      .min(1, "Limit must be at least 1")
      .max(100, "Limit must be at most 100")
      .optional()
      .default(20),
    search: z.string().max(100, "Search term is too long").trim().optional(),
    /**
     * Optional verification-status filter. Accepts any valid seller
     * verification status, or an empty string (treated as "no filter" /
     * all statuses).
     */
    status: z
      .union([sellerVerificationStatusEnum, z.literal("")])
      .optional(),
  }),
});

// ============================================
// Store Review History Schema
// ============================================

export const storeReviewHistorySchema = z.object({
  params: z.object({
    storeId: idField,
  }),
});

// ============================================
// Type Inference Helpers
// ============================================

export type ReviewStoreInput = z.infer<typeof reviewStoreSchema>["body"] & {
  storeId: z.infer<typeof reviewStoreSchema>["params"]["storeId"];
};

export type ReviewProductInput = z.infer<typeof reviewProductSchema>["body"] & {
  productId: z.infer<typeof reviewProductSchema>["params"]["productId"];
};

export type VerifySellerInput = z.infer<typeof verifySellerSchema>["body"] & {
  sellerId: z.infer<typeof verifySellerSchema>["params"]["sellerId"];
};

export type VerifySellerDocumentInput = z.infer<
  typeof verifySellerDocumentSchema
>["params"] &
  z.infer<typeof verifySellerDocumentSchema>["body"];

export type ModerateContentInput = z.infer<
  typeof moderateContentSchema
>["body"] & {
  contentId: z.infer<typeof moderateContentSchema>["params"]["contentId"];
};

export type ResolveDisputeInput = z.infer<
  typeof resolveDisputeSchema
>["body"] & {
  disputeId: z.infer<typeof resolveDisputeSchema>["params"]["disputeId"];
};

export type BulkModerationInput = z.infer<typeof bulkModerationSchema>["body"];

export type ModerationFilters = z.infer<typeof moderationFiltersSchema>["query"];
export type ModerationHistoryFilters = z.infer<
  typeof moderationHistoryFiltersSchema
>["query"];

export type UpdatePriorityInput = z.infer<
  typeof updatePrioritySchema
>["body"] & {
  itemId: z.infer<typeof updatePrioritySchema>["params"]["itemId"];
};

export type UpdateModerationNoteInput = z.infer<
  typeof updateModerationNoteSchema
>["body"] & {
  itemId: z.infer<typeof updateModerationNoteSchema>["params"]["itemId"];
};

export type GetPendingStoresQuery = z.infer<
  typeof getPendingStoresQuerySchema
>["query"];

export type GetAllStoresQuery = z.infer<
  typeof getAllStoresQuerySchema
>["query"];

export type GetPendingSellersQuery = z.infer<
  typeof getPendingSellersQuerySchema
>["query"];

export type GetAllSellersQuery = z.infer<
  typeof getAllSellersQuerySchema
>["query"];

export type StoreReviewHistoryParams = z.infer<
  typeof storeReviewHistorySchema
>["params"];

// ============================================
// Export All Schemas
// ============================================

export const moderatorSchemas = {
  reviewStore: reviewStoreSchema,
  reviewProduct: reviewProductSchema,
  verifySeller: verifySellerSchema,
  verifySellerDocument: verifySellerDocumentSchema,
  moderateContent: moderateContentSchema,
  resolveDispute: resolveDisputeSchema,
  bulkModeration: bulkModerationSchema,
  moderationFilters: moderationFiltersSchema,
  moderationHistoryFilters: moderationHistoryFiltersSchema,
  updatePriority: updatePrioritySchema,
  updateModerationNote: updateModerationNoteSchema,
  getPendingStoresQuery: getPendingStoresQuerySchema,
  getAllStoresQuery: getAllStoresQuerySchema,
  getPendingSellersQuery: getPendingSellersQuerySchema,
  getAllSellersQuery: getAllSellersQuerySchema,
  storeReviewHistory: storeReviewHistorySchema,
};

export default moderatorSchemas;