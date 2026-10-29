// src/sellers/seller.types.ts

// ============================================
// ENUMS
// ============================================

export enum SellerStatus {
  PENDING = "pending",
  KYC_SUBMITTED = "kyc_submitted",
  KYC_UPDATE_PENDING = "kyc_update_pending",
  VERIFIED = "verified",
  REJECTED = "rejected",
  SUSPENDED = "suspended",
  CLOSED = "closed",
}

export enum BusinessType {
  SOLE_PROPRIETORSHIP = "sole_proprietorship",
  LLC = "llc",
  CORPORATION = "corporation",
  PARTNERSHIP = "partnership",
  NON_PROFIT = "non_profit",
}

export enum PayoutMethod {
  BANK = "bank",
  MPESA = "mpesa",
  PAYPAL = "paypal",
  STRIPE = "stripe",
  CRYPTO = "crypto",
}

export enum PayoutSchedule {
  WEEKLY = "weekly",
  BIWEEKLY = "biweekly",
  MONTHLY = "monthly",
  DAILY = "daily",
}

export enum SellerTier {
  BASIC = "basic",
  PRO = "pro",
  ENTERPRISE = "enterprise",
}

export enum KycDocumentType {
  BUSINESS_REGISTRATION = "business_registration",
  BUSINESS_LICENSE = "business_license",
  TAX_CERTIFICATE = "tax_certificate",
  ID_FRONT = "id_front",
  ID_BACK = "id_back",
  SELFIE = "selfie",
  PROOF_OF_ADDRESS = "proof_of_address",
  BANK_STATEMENT = "bank_statement",
}

export enum SellerSetupStep {
  NONE = "none",
  BASIC_INFO = "basic_info",
  BUSINESS_DETAILS = "business_details",
  KYC_DOCUMENTS = "kyc_documents",
  PAYMENT_SETUP = "payment_setup",
  COMPLETE = "complete",
}

export enum SellerEventType {
  SELLER_CREATED = "seller.created",
  SELLER_UPDATED = "seller.updated",
  SELLER_VERIFIED = "seller.verified",
  SELLER_REJECTED = "seller.rejected",
  SELLER_SUSPENDED = "seller.suspended",
  SELLER_REINSTATED = "seller.reinstated",
  SELLER_TIER_CHANGED = "seller.tier.changed",
  SELLER_PAYOUT_UPDATED = "seller.payout.updated",
  SELLER_KYC_EXPIRING = "seller.kyc.expiring",
  SELLER_DOCUMENT_UPLOADED = "seller.document.uploaded",
  SELLER_DOCUMENT_VERIFIED = "seller.document.verified",
  SELLER_DOCUMENT_REJECTED = "seller.document.rejected",
  SELLER_DOCUMENT_DELETED = "seller.document.deleted",
}

// ============================================
// DOCUMENT TYPES
// ============================================

export type DocumentVerificationStatus = "pending" | "verified" | "rejected";

export interface DocumentReference {
  type: KycDocumentType;
  public_id: string;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: Date;
  verification_status: DocumentVerificationStatus;
  verified_at?: Date;
  rejection_reason?: string;
}

// ============================================
// SELLER PROFILE
// ============================================

export interface SellerProfile {
  id: string;
  user_id: string;

  legal_business_name: string;
  trading_name: string;
  business_type: BusinessType;
  tax_id: string;
  registration_number: string;
  country: string;
  state: string;
  city: string;
  business_address: string;
  business_phone: string;

  status: SellerStatus;
  verification_status: DocumentVerificationStatus | "suspended";
  risk_score: number;
  kyc_expiry_date?: Date;
  last_kyc_review_date?: Date;
  kyc_documents: DocumentReference[];
  verified_at?: Date;
  rejected_reason?: string;
  suspension_reason?: string;
  suspension_date?: Date;

  payout_method: PayoutMethod;
  bank_account_name?: string;
  bank_account_number?: string;
  bank_routing_number?: string;
  bank_name?: string;
  bank_country?: string;
  paypal_email?: string;
  mpesa_phone?: string;
  stripe_connect_id?: string;

  commission_rate: number;
  custom_commission_rate?: number;
  payout_schedule: PayoutSchedule;
  minimum_payout: number;
  currency: string;
  hold_period_days: number;

  tier: SellerTier;
  max_stores_allowed: number;
  max_products_per_store: number;
  auto_approve_products: boolean;
  enable_negotiation: boolean;
  allow_backorders: boolean;
  allow_preorders: boolean;

  rating: number;
  total_reviews: number;
  total_orders: number;
  total_products: number;
  total_stores: number;
  fulfillment_rate: number;
  response_rate: number;
  response_time_hours?: number;
  cancellation_rate: number;
  dispute_rate: number;

  created_at: Date;
  updated_at: Date;
  created_by?: string;
  updated_by?: string;
  metadata?: Record<string, any>;
}

// ============================================
// INPUTS
// ============================================

export interface CreateSellerInput {
  legal_business_name: string;
  trading_name: string;
  business_type: BusinessType;
  tax_id: string;
  registration_number: string;
  country: string;
  state: string;
  city: string;
  business_address: string;
  business_phone: string;

  payout_method: PayoutMethod;
  bank_account_name?: string;
  bank_account_number?: string;
  bank_routing_number?: string;
  bank_name?: string;
  bank_country?: string;
  paypal_email?: string;
  mpesa_phone?: string;

  currency?: string;
  payout_schedule?: PayoutSchedule;
  minimum_payout?: number;
  hold_period_days?: number;

  accepted_terms_version: string;
  accepted_privacy_version: string;
  ip_address?: string;
  user_agent?: string;
}

export interface UpdateSellerInput {
  legal_business_name?: string;
  trading_name?: string;
  business_type?: BusinessType;
  tax_id?: string;
  registration_number?: string;
  business_address?: string;
  business_phone?: string;

  country?: string;
  state?: string;
  city?: string;
  currency?: string;

  payout_method?: PayoutMethod;
  bank_account_name?: string;
  bank_account_number?: string;
  bank_routing_number?: string;
  bank_name?: string;
  bank_country?: string;
  paypal_email?: string;
  mpesa_phone?: string;

  auto_approve_products?: boolean;
  enable_negotiation?: boolean;
  allow_backorders?: boolean;
  allow_preorders?: boolean;
  payout_schedule?: PayoutSchedule;
  minimum_payout?: number;
  hold_period_days?: number;
}

export interface UploadKycDocumentInput {
  document_type: KycDocumentType;
  file: Express.Multer.File | string;
  filename: string;
}

// ============================================
// KYC DOCUMENT REQUIREMENTS
// ============================================

export const KYC_DOCUMENT_REQUIREMENTS: Record<BusinessType, KycDocumentType[]> = {
  [BusinessType.SOLE_PROPRIETORSHIP]: [
    KycDocumentType.ID_FRONT,
    KycDocumentType.ID_BACK,
    KycDocumentType.SELFIE,
    KycDocumentType.PROOF_OF_ADDRESS,
    KycDocumentType.TAX_CERTIFICATE,
  ],
  [BusinessType.LLC]: [
    KycDocumentType.BUSINESS_REGISTRATION,
    KycDocumentType.TAX_CERTIFICATE,
    KycDocumentType.ID_FRONT,
    KycDocumentType.ID_BACK,
    KycDocumentType.SELFIE,
  ],
  [BusinessType.CORPORATION]: [
    KycDocumentType.BUSINESS_REGISTRATION,
    KycDocumentType.TAX_CERTIFICATE,
    KycDocumentType.ID_FRONT,
    KycDocumentType.ID_BACK,
    KycDocumentType.SELFIE,
  ],
  [BusinessType.PARTNERSHIP]: [
    KycDocumentType.BUSINESS_REGISTRATION,
    KycDocumentType.TAX_CERTIFICATE,
    KycDocumentType.ID_FRONT,
    KycDocumentType.ID_BACK,
    KycDocumentType.SELFIE,
  ],
  [BusinessType.NON_PROFIT]: [
    KycDocumentType.BUSINESS_REGISTRATION,
    KycDocumentType.TAX_CERTIFICATE,
    KycDocumentType.ID_FRONT,
    KycDocumentType.ID_BACK,
    KycDocumentType.SELFIE,
  ],
};

export const ALWAYS_REQUIRED_DOCUMENTS: KycDocumentType[] = [
  KycDocumentType.ID_FRONT,
  KycDocumentType.ID_BACK,
  KycDocumentType.SELFIE,
  KycDocumentType.PROOF_OF_ADDRESS,
];

export const ALL_KYC_DOCUMENT_TYPES: KycDocumentType[] = Object.values(KycDocumentType);

export function getRequiredDocumentsForSeller(
  businessType: BusinessType,
  payoutMethod: PayoutMethod
): KycDocumentType[] {
  const required = new Set<KycDocumentType>(
    KYC_DOCUMENT_REQUIREMENTS[businessType] ?? []
  );
  if (payoutMethod === PayoutMethod.BANK) {
    required.add(KycDocumentType.BANK_STATEMENT);
  }
  return Array.from(required);
}

// ============================================
// STATUS / PROGRESS
// ============================================

export interface SellerStatusCheck {
  status: SellerStatus;
  verification_status?: DocumentVerificationStatus | "suspended";
  is_active: boolean;
  can_create_stores: boolean;
  can_update_stores: boolean;
  has_pending_kyc_update: boolean;
  kyc_expired: boolean;
  current_store_count: number;
  max_stores_allowed: number;
  can_create_more_stores: boolean;
  block_reason?: string;
  actions_required?: string[];

  onboarding_step: SellerSetupStep;
  onboarding_complete: boolean;
  missing_fields: string[];
  missing_documents: KycDocumentType[];
}

export interface SellerSetupProgress {
  currentStep: SellerSetupStep;
  isComplete: boolean;
  missingFields: string[];
  requiredDocuments: KycDocumentType[];
  uploadedDocuments: KycDocumentType[];
  nextStepAction: "upload_documents" | "configure_payout" | "create_store";
}

// ============================================
// METRICS / QUERY
// ============================================

export interface SellerMetrics {
  seller_id: string;
  period: "today" | "week" | "month" | "year" | "all";
  total_revenue: number;
  revenue_by_currency: Record<string, number>;
  platform_fees: number;
  net_payout: number;
  total_orders: number;
  completed_orders: number;
  cancelled_orders: number;
  refunded_orders: number;
  average_order_value: number;
  total_products: number;
  active_products: number;
  out_of_stock_products: number;
  total_stores: number;
  active_stores: number;
  average_rating: number;
  total_reviews: number;
  positive_reviews: number;
  negative_reviews: number;
}

export interface GetSellersQuery {
  page?: number;
  limit?: number;
  sortBy?: "rating" | "total_orders" | "created_at" | "fulfillment_rate" | "revenue";
  sortOrder?: "asc" | "desc";
  status?: SellerStatus[];
  country?: string[];
  tier?: SellerTier[];
  business_type?: BusinessType[];
  has_stores?: boolean;
  min_rating?: number;
  max_rating?: number;
  date_from?: Date;
  date_to?: Date;
  search?: string;
  min_revenue?: number;
  max_revenue?: number;
}

// ============================================
// WEBHOOKS
// ============================================

export interface SellerWebhookPayload<T = any> {
  event_type: SellerEventType;
  seller_id: string;
  user_id: string;
  timestamp: string;
  previous_data?: Partial<SellerProfile>;
  current_data: T;
  triggered_by: "system" | "admin" | "seller";
  ip_address?: string;
}