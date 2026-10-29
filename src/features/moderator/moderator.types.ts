// src/types/moderator.types.ts

import type {
  BusinessType,
  DocumentReference,
  DocumentVerificationStatus,
  KycDocumentType,
  PayoutMethod,
  SellerStatus,
  SellerSetupStep,
} from "../seller/seller.types";

// ============================================
// ENUMS & CONSTANTS
// ============================================

export enum ModerationTarget {
  STORE = "store",
  PRODUCT = "product",
  SELLER = "seller",
  REVIEW = "review",
  CONTENT = "content",
  DISPUTE = "dispute",
}

export enum ModerationStatus {
  PENDING = "pending",
  IN_REVIEW = "in_review",
  APPROVED = "approved",
  REJECTED = "rejected",
  FLAGGED = "flagged",
  SUSPENDED = "suspended",
  REMOVED = "removed",
  RESOLVED = "resolved",
}

export enum ModerationPriority {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  URGENT = "urgent",
}

export enum ModerationAction {
  APPROVED = "approved",
  REJECTED = "rejected",
  FLAGGED = "flagged",
  SUSPENDED = "suspended",
  REMOVED = "removed",
  RESOLVED = "resolved",
}

// ============================================
// CORE MODERATION TYPES
// ============================================
//
// NOTE: All timestamp fields are `string` (ISO 8601) because they cross
// the HTTP boundary. Postgres returns strings for `timestamptz` by default
// when serialized through `pg`, and the service layer does not re-wrap them.

export interface ModerationItem {
  id: string;
  target_type: ModerationTarget;
  target_id: string;
  status: ModerationStatus;
  priority: ModerationPriority;
  submitted_by: string;
  submitted_at: string;
  moderated_by?: string | null;
  moderated_at?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ModerationItemWithDetails extends ModerationItem {
  target?: {
    name?: string;
    title?: string;
    description?: string;
    images?: string[];
    seller_id?: string;
    store_id?: string;
    user_id?: string;
  };
  submitter?: {
    id: string;
    full_name: string;
    email: string;
    role: string;
  };
  moderator?: {
    id: string;
    full_name: string;
    email: string;
  };
}

// ============================================
// QUEUE & STATS
// ============================================

export interface ModerationQueue {
  pending: number;
  in_review: number;
  resolved: number;
  by_type: Record<ModerationTarget, number>;
  by_priority: Record<ModerationPriority, number>;
  items: ModerationItem[];
}

export interface ModerationStats {
  total_reviewed: number;
  approved: number;
  rejected: number;
  flagged: number;
  suspended: number;
  removed: number;
  pending: number;
  in_review: number;
  response_time_avg: number; // hours
  resolution_rate: number; // percentage
  today_pending: number;
  this_week_pending: number;
}

// ============================================
// STORE MODERATION
// ============================================
//
// `StoreModerationDetails` mirrors the JSON object built by
// `getAllStoresForModeration` and `getPendingStoresForModeration` in
// `moderator.service.ts`. Fields that are only sometimes selected are
// declared optional so the same type covers both queries.

export interface StoreModerationDetails {
  // ---- Identity ----
  id: string;
  name: string;
  slug: string;
  seller_id: string;

  // ---- Copy ----
  description?: string;
  tagline?: string;

  // ---- Media ----
  logo_url?: string;
  banner_url?: string;
  cover_image_url?: string;

  // ---- Contact ----
  contact_email?: string;
  contact_phone?: string;
  support_hours?: string;

  // ---- Location ----
  location?: string;
  country?: string;
  timezone?: string;

  // ---- Meta ----
  social_links: Record<string, string>;
  type: string;
  category: string;
  sub_categories?: string[];
  currency?: string;
  language?: string;
  return_policy?: Record<string, unknown>;
  shipping_origin?: Record<string, unknown>;

  // ---- Status ----
  /** Raw `stores.status` — e.g. 'active' | 'pending_approval' | 'rejected' | 'suspended' | 'draft' | 'closed' */
  status: string;
  is_approved: boolean;
  is_active?: boolean;
  rejection_reason?: string;

  // ---- Timestamps ----
  created_at: string;
  updated_at: string;

  // ---- Metrics (optional — only populated by some queries) ----
  total_products?: number;
  total_orders?: number;
  total_reviews?: number;
  average_rating?: number;
  view_count?: number;
}

export interface SellerDetailsForModeration {
  id: string;
  user_id: string;
  legal_business_name: string;
  trading_name?: string;
  business_type: BusinessType;
  country: string;
  state?: string;
  city?: string;
  business_address?: string;
  business_phone?: string;
  status: SellerStatus;
  verification_status: DocumentVerificationStatus | "suspended";
  rating: number;
  total_reviews: number;
  total_orders: number;
  total_products: number;
  total_stores: number;
  fulfillment_rate: number;
  response_rate: number;
  email: string;
  full_name: string;
  phone?: string | null;
  user_joined_at: string;

  /**
   * KYC documents — only populated by the seller-moderation queries.
   * Store-moderation queries omit this because they don't need KYC.
   */
  kyc_documents?: DocumentReference[];
}

export interface PendingStoreReview {
  moderation_item: ModerationItem;
  store: StoreModerationDetails;
  seller: SellerDetailsForModeration;
  products_count: number;
  reviews_count: number;
  orders_count: number;
  review_history: ModerationHistoryEntry[];
}

// ============================================
// MODERATOR PENDING SELLER ROW (the KYC queue)
// ============================================

/**
 * Canonical shape returned by `GET /moderator/sellers/pending`.
 *
 * This is the wire contract between `moderation.controller.ts` and
 * the moderator UI (`ModeratorSellers.tsx` + `moderatorApi.ts` +
 * `moderatorSlice.ts`). Every consumer reads from this shape.
 *
 * NOTE: All date fields are ISO strings because they cross HTTP.
 */
export interface ModeratorPendingSellerRow {
  /** Moderation queue row id (equals seller_id for seller reviews) */
  id: string;

  /** Queue priority — 'low' | 'medium' | 'high' | 'urgent' */
  priority: "low" | "medium" | "high" | "urgent";

  /** Queue status — 'pending' | 'in_review' | 'resolved' */
  status: string;

  /** When the seller entered the queue (ISO 8601) */
  submitted_at: string;

  seller: {
    // ---- Identity ----
    id: string;
    user_id: string;

    // ---- Business ----
    legal_business_name: string;
    trading_name?: string;
    business_type: BusinessType;
    tax_id?: string;
    registration_number?: string;

    // ---- Address ----
    country: string;
    state?: string;
    city?: string;
    business_address?: string;
    business_phone?: string;

    // ---- Status ----
    verification_status: DocumentVerificationStatus | "suspended";
    status: SellerStatus;

    // ---- Payout ----
    payout_method?: PayoutMethod;
    bank_account_name?: string;
    bank_account_number?: string;
    bank_routing_number?: string;
    bank_name?: string;
    bank_country?: string;
    paypal_email?: string;
    mpesa_phone?: string;

    // ---- KYC documents — the whole point of this queue ----
    kyc_documents: DocumentReference[];

    // ---- Joined user ----
    user: {
      id: string;
      full_name: string;
      email: string;
      phone?: string;
    };

    // ---- Timestamps (ISO 8601) ----
    created_at?: string;
    updated_at?: string;
  };
}

// ============================================
// MODERATOR SELLER ROW (pending + all sellers)
// ============================================

/**
 * Canonical shape returned by:
 *   - `GET /moderator/sellers/pending`  (pending only)
 *   - `GET /moderator/sellers`          (all statuses)
 *
 * The `verification_status` field drives the badge on the seller card.
 * The Approve/Reject/Document actions are shown only when the seller
 * needs review (status is one of the pending-ish values).
 *
 * NOTE: All date fields are ISO strings because they cross HTTP.
 */
export interface ModeratorSellerRow {
  /** Moderation queue row id (equals seller_id for seller reviews) */
  id: string;

  /** Queue priority — 'low' | 'medium' | 'high' | 'urgent' */
  priority: "low" | "medium" | "high" | "urgent";

  /** Queue status — 'pending' | 'in_review' | 'resolved' */
  status: string;

  /** When the seller entered the queue (ISO 8601) */
  submitted_at: string;

  seller: {
    // ---- Identity ----
    id: string;
    user_id: string;

    // ---- Business ----
    legal_business_name: string;
    trading_name?: string;
    business_type: BusinessType;
    tax_id?: string;
    registration_number?: string;

    // ---- Address ----
    country: string;
    state?: string;
    city?: string;
    business_address?: string;
    business_phone?: string;

    // ---- Status ----
    /**
     * Drives the seller card badge:
     *   'pending' | 'verified' | 'rejected' | 'suspended'
     */
    verification_status: DocumentVerificationStatus | "suspended";
    /** Seller account status — 'pending' | 'verified' | 'rejected' | 'suspended' | 'closed' */
    status: SellerStatus;

    // ---- Payout ----
    payout_method?: PayoutMethod;
    bank_account_name?: string;
    bank_account_number?: string;
    bank_routing_number?: string;
    bank_name?: string;
    bank_country?: string;
    paypal_email?: string;
    mpesa_phone?: string;

    // ---- KYC documents ----
    kyc_documents: DocumentReference[];

    // ---- Joined user ----
    user: {
      id: string;
      full_name: string;
      email: string;
      phone?: string;
    };

    // ---- Timestamps (ISO 8601) ----
    created_at?: string;
    updated_at?: string;
  };
}

// ============================================
// MODERATOR STORE ROW (pending + all stores)
// ============================================

/**
 * Canonical shape returned by:
 *   - `GET /moderator/stores/pending`  (pending only)
 *   - `GET /moderator/stores`          (all statuses)
 *
 * The `status` field drives the badge on the store card, and the UI
 * only shows Approve/Reject buttons when `status === 'pending'`.
 *
 * NOTE: All date fields are ISO strings because they cross HTTP.
 */
export interface ModeratorStoreRow {
  /** Moderation queue row id (equals store_id for store reviews) */
  id: string;

  /** Target type — always 'store' for this row shape */
  target_type: ModerationTarget.STORE;

  /** Store id being moderated (mirrors `store.id`) */
  target_id: string;

  /** Store status — 'pending' | 'approved' | 'rejected' | 'suspended' | 'in_review' */
  status: ModerationStatus;

  /** Queue priority — 'low' | 'medium' | 'high' | 'urgent' */
  priority: ModerationPriority;

  /** When the store entered the queue (ISO 8601) */
  submitted_at: string;

  /** Submitter (seller user id) */
  submitted_by: string;

  /** Optional moderation notes (e.g. rejection reason) */
  notes?: string;

  /** Free-form metadata from the backend */
  metadata?: Record<string, unknown>;

  /** ISO 8601 last update timestamp */
  updated_at?: string;

  store: {
    id: string;
    name: string;
    slug: string;
    description?: string;
    logo_url?: string;
    banner_url?: string;
    cover_image_url?: string;
    location?: string;
    contact_email?: string;
    contact_phone?: string;
    support_hours?: string;
    social_links: Record<string, string>;
    type: string;
    category: string;
    sub_categories?: string[];
    currency?: string;
    language?: string;
    is_active: boolean;
    is_approved: boolean;
    created_at: string;
    updated_at?: string;
    seller_id: string;
  };

  seller: {
    id: string;
    business_name: string;
    trading_name?: string;
    business_type: string;
    country: string;
    verification_status: DocumentVerificationStatus | "suspended";
    status: SellerStatus;
    user: {
      id: string;
      full_name: string;
      email: string;
      phone: string | null;
    };
  };
}

// ============================================
// STORE STATS
// ============================================

/**
 * Aggregated store statistics returned by `GET /moderator/stores/stats`.
 * Powers the stat cards on the Store Moderation page.
 */
export interface StoreStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  inactive: number;
  deleted: number;
  suspended: number;
  total_products: number;
  total_orders: number;
  category_distribution: Array<{ category: string; count: number }>;
}

// ============================================
// MODERATION HISTORY
// ============================================

export interface ModerationHistoryEntry {
  id: string;
  moderator_id: string;
  moderator_name: string;
  moderator_email: string;
  action: string;
  target_type: string;
  target_id: string;
  target_name?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

// ============================================
// INPUT TYPES
// ============================================

export interface CreateModerationItemInput {
  target_type: ModerationTarget;
  target_id: string;
  submitted_by: string;
  priority?: ModerationPriority;
  metadata?: Record<string, unknown>;
  notes?: string;
}

export interface ReviewStoreInput {
  storeId: string;
  approved: boolean;
  rejection_reason?: string;
  notes?: string;
  moderator_id: string;
}

export interface ReviewProductInput {
  productId: string;
  approved: boolean;
  rejection_reason?: string;
  notes?: string;
  moderator_id: string;
}

export interface VerifySellerInput {
  sellerId: string;
  verified: boolean;
  reason?: string;
  moderator_id: string;
}

/**
 * Verify one KYC document of a seller.
 * Mirrors `verifyKycDocument` on the seller API.
 */
export interface VerifySellerDocumentInput {
  sellerId: string;
  documentType: KycDocumentType;
  verification_status: "verified" | "rejected";
  rejection_reason?: string;
  moderator_id: string;
}

export interface ModerateContentInput {
  contentId: string;
  action: ModerationAction;
  reason?: string;
  moderator_id: string;
}

export interface ResolveDisputeInput {
  disputeId: string;
  resolution: "refund" | "replacement" | "dismiss" | "escalate";
  notes?: string;
  refund_amount?: number;
  moderator_id: string;
}

export interface ModerationFilters {
  target_type?: ModerationTarget;
  status?: ModerationStatus;
  priority?: ModerationPriority;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: "created_at" | "priority" | "status" | "updated_at";
  sortOrder?: "asc" | "desc";
  date_from?: string;
  date_to?: string;
}

/** Query params for `GET /moderator/stores` (all stores). */
export interface GetAllStoresParams {
  page?: number;
  limit?: number;
  search?: string;
  /** Optional single-status filter — omit to fetch all statuses. */
  status?: ModerationStatus | "";
}

/** Query params for `GET /moderator/stores/pending`. */
export interface GetPendingStoresParams {
  page?: number;
  limit?: number;
  search?: string;
}

/** Query params for `GET /moderator/sellers` (all sellers). */
export interface GetAllSellersParams {
  page?: number;
  limit?: number;
  search?: string;
  /**
   * Optional filter — 'pending' | 'verified' | 'rejected' | 'suspended'.
   * Omit (or pass an empty string) to fetch all sellers.
   */
  status?: DocumentVerificationStatus | "suspended" | "";
}

/** Query params for `GET /moderator/sellers/pending`. */
export interface GetPendingSellersParams {
  page?: number;
  limit?: number;
  search?: string;
}

// ============================================
// RESPONSE TYPES
// ============================================

export interface ModerationQueueResponse {
  success: boolean;
  data: ModerationQueue;
}

export interface ModerationStatsResponse {
  success: boolean;
  data: ModerationStats;
}

export interface ModerationItemResponse {
  success: boolean;
  data: ModerationItemWithDetails;
}

export interface ModerationItemsResponse {
  success: boolean;
  data: ModerationItemWithDetails[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface ModerationHistoryResponse {
  success: boolean;
  data: ModerationHistoryEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface ModerationActionResponse {
  success: boolean;
  message: string;
  data?: ModerationItem;
}

/**
 * Response for `GET /moderator/sellers/pending`.
 */
export interface PendingSellersResponse {
  success: boolean;
  data: ModeratorPendingSellerRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

/**
 * Response for `GET /moderator/sellers` (all statuses).
 */
export interface AllSellersResponse {
  success: boolean;
  data: ModeratorSellerRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

/**
 * Response for `GET /moderator/stores` (all statuses).
 * Also used for `GET /moderator/stores/pending` since the row shape is identical.
 */
export interface AllStoresResponse {
  success: boolean;
  data: ModeratorStoreRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

/**
 * Response for `GET /moderator/stores/stats`.
 */
export interface StoreStatsResponse {
  success: boolean;
  data: StoreStats;
}

/**
 * Response for `PATCH /sellers/admin/sellers/:sellerId/documents/:documentType/verify`.
 */
export interface VerifyDocumentResponse {
  success: boolean;
  message: string;
  data: {
    document: DocumentReference;
    sellerFullyVerified: boolean;
  };
}

// ============================================
// MODERATOR PERMISSIONS
// ============================================

export interface ModeratorPermissions {
  can_review_stores: boolean;
  can_review_products: boolean;
  can_verify_sellers: boolean;
  can_moderate_content: boolean;
  can_resolve_disputes: boolean;
  can_suspend_users: boolean;
  can_view_analytics: boolean;
  can_export_reports: boolean;
  can_bulk_actions: boolean;
}

export const DEFAULT_MODERATOR_PERMISSIONS: ModeratorPermissions = {
  can_review_stores: true,
  can_review_products: true,
  can_verify_sellers: true,
  can_moderate_content: true,
  can_resolve_disputes: true,
  can_suspend_users: false,
  can_view_analytics: true,
  can_export_reports: false,
  can_bulk_actions: false,
};

export const SENIOR_MODERATOR_PERMISSIONS: ModeratorPermissions = {
  can_review_stores: true,
  can_review_products: true,
  can_verify_sellers: true,
  can_moderate_content: true,
  can_resolve_disputes: true,
  can_suspend_users: true,
  can_view_analytics: true,
  can_export_reports: true,
  can_bulk_actions: true,
};

// ============================================
// MODERATOR DASHBOARD
// ============================================

export interface ModeratorDashboardData {
  stats: ModerationStats;
  recent_activity: ModerationHistoryEntry[];
  queue: {
    total: number;
    by_type: Record<ModerationTarget, number>;
    urgent: number;
  };
  performance: {
    reviews_today: number;
    reviews_this_week: number;
    avg_response_time: number;
    approval_rate: number;
  };
  alerts: {
    type: "info" | "warning" | "error";
    message: string;
    action?: {
      label: string;
      url: string;
    };
  }[];
}

// ============================================
// BULK ACTIONS
// ============================================

export interface BulkModerationInput {
  target_type: ModerationTarget;
  target_ids: string[];
  action: ModerationAction;
  notes?: string;
  moderator_id: string;
}

export interface BulkModerationResult {
  success: boolean;
  processed: number;
  failed: number;
  errors: {
    id: string;
    error: string;
  }[];
}

// ============================================
// MODERATOR QUEUE ITEM WITH STORE DETAILS
// ============================================

export interface ModerationQueueItemWithStore {
  moderation_item: ModerationItem;
  store: {
    id: string;
    name: string;
    slug: string;
    description?: string;
    logo_url?: string;
    banner_url?: string;
    location?: string;
    contact_email?: string;
    status: string;
    is_approved: boolean;
    created_at: string;
    seller_id: string;
  };
  seller: SellerDetailsForModeration;
}