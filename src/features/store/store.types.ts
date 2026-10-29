// src/types/store.types.ts

// ============================================
// ENUMS & CONSTANTS
// ============================================

/**
 * Store Status
 * 
 * With the single-approval flow, stores are created as ACTIVE immediately
 * once the seller is verified. There is no store-level moderation.
 * 
 * - ACTIVE: Store is live and selling (default state after creation)
 * - SUSPENDED: Temporarily disabled (e.g., seller suspended, policy violation)
 * - CLOSED: Permanently closed by seller or admin
 * 
 * Note: DRAFT, PENDING_APPROVAL, and REJECTED are kept for backward
 * compatibility but should not be used in new code.
 */
export enum StoreStatus {
  ACTIVE = 'active',             // ✅ Store is live and selling (default)
  SUSPENDED = 'suspended',       // Temporarily disabled
  CLOSED = 'closed',             // Permanently closed
  
  // @deprecated - Kept for backward compatibility only
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  REJECTED = 'rejected',
}

export enum StoreType {
  PHYSICAL = 'physical',
  DIGITAL = 'digital',
  SERVICES = 'services',
  MIXED = 'mixed',
}

export enum StoreCategory {
  ELECTRONICS = 'electronics',
  FASHION = 'fashion',
  HOME_GARDEN = 'home_garden',
  BEAUTY = 'beauty',
  BOOKS = 'books',
  TOYS = 'toys',
  SPORTS = 'sports',
  AUTOMOTIVE = 'automotive',
  HEALTH = 'health',
  FOOD = 'food',
  SERVICES = 'services',
  OTHER = 'other',
}

// ============================================
// STORE PROFILE
// ============================================

export interface StoreProfile {
  // ===== IDENTITY =====
  id: string;
  seller_id: string;
  
  // ===== BRANDING =====
  name: string;
  slug: string;
  description?: string;
  tagline?: string;
  logo_url?: string;
  banner_url?: string;
  cover_image_url?: string;
  
  // ===== CONTACT (Customer-Facing) =====
  contact_email?: string;
  contact_phone?: string;
  support_hours?: string;
  
  // ===== LOCATION =====
  location?: string;
  country?: string;
  timezone?: string;
  
  // ===== SOCIAL MEDIA =====
  social_links: Record<string, string>;
  
  // ===== STORE SETTINGS =====
  type: StoreType;
  category: StoreCategory;
  sub_categories?: string[];
  status: StoreStatus;
  
  // ===== OPERATIONAL PREFERENCES =====
  currency: string;
  language?: string;
  
  // ===== RETURN & REFUND POLICY =====
  return_policy?: {
    days: number;
    condition: 'unused' | 'opened' | 'any';
    refund_method: 'original' | 'store_credit';
    restocking_fee_percent?: number;
    notes?: string;
  };
  
  // ===== SHIPPING PRE-SETS =====
  shipping_origin?: {
    country: string;
    state?: string;
    city?: string;
    zip_code?: string;
  };
  
  // ===== LIFECYCLE (No more moderation fields) =====
  is_active: boolean;            // true when store is live
  activated_at?: Date;           // When store went live (was published_at)
  
  // ===== ADMIN ACTIONS (Suspension/Closure) =====
  suspended_at?: Date;
  suspended_by?: string;
  suspension_reason?: string;
  closed_at?: Date;
  closed_by?: string;
  closure_reason?: string;
  
  // ===== METRICS =====
  total_products: number;
  total_orders: number;
  total_reviews: number;
  average_rating: number;
  view_count: number;
  
  // ===== AUDIT =====
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
  metadata?: Record<string, any>;
}

// ============================================
// STORE CREATION
// ============================================

export interface CreateStoreInput {
  // ===== MANDATORY =====
  name: string;
  category: StoreCategory;
  type: StoreType;
  
  // ===== OPTIONAL (Branding) =====
  description?: string;
  tagline?: string;
  logo_url?: string;
  banner_url?: string;
  cover_image_url?: string;
  
  // ===== OPTIONAL (Contact) =====
  contact_email?: string;
  contact_phone?: string;
  support_hours?: string;
  
  // ===== OPTIONAL (Location) =====
  location?: string;
  country?: string;
  timezone?: string;
  
  // ===== OPTIONAL (Social) =====
  social_links?: Record<string, string>;
  
  // ===== OPTIONAL (Settings) =====
  sub_categories?: string[];
  currency?: string;
  language?: string;
  
  // ===== OPTIONAL (Policies) =====
  return_policy?: {
    days: number;
    condition: 'unused' | 'opened' | 'any';
    refund_method: 'original' | 'store_credit';
    restocking_fee_percent?: number;
    notes?: string;
  };
  
  shipping_origin?: {
    country: string;
    state?: string;
    city?: string;
    zip_code?: string;
  };
}

// ============================================
// STORE UPDATE
// ============================================

export interface UpdateStoreInput {
  // Branding
  name?: string;
  description?: string;
  tagline?: string;
  logo_url?: string;
  banner_url?: string;
  cover_image_url?: string;
  
  // Contact
  contact_email?: string;
  contact_phone?: string;
  support_hours?: string;
  
  // Location
  location?: string;
  country?: string;
  timezone?: string;
  
  // Social
  social_links?: Record<string, string>;
  
  // Settings
  category?: StoreCategory;
  sub_categories?: string[];
  currency?: string;
  language?: string;
  
  // Policies
  return_policy?: {
    days: number;
    condition: 'unused' | 'opened' | 'any';
    refund_method: 'original' | 'store_credit';
    restocking_fee_percent?: number;
    notes?: string;
  };
  
  shipping_origin?: {
    country: string;
    state?: string;
    city?: string;
    zip_code?: string;
  };
  
  // Status (Admin only)
  is_active?: boolean;
}

// ============================================
// STORE STATUS CHECK (Gatekeeper for operations)
// ============================================

export interface StoreStatusCheck {
  id: string;
  status: StoreStatus;
  is_live: boolean;              // status === 'active' && is_active === true
  can_edit: boolean;             // Can seller edit this store
  can_add_products: boolean;     // Can seller add products
  can_process_orders: boolean;   // Can process orders
  block_reason?: string;
  actions_required?: string[];
}

// ============================================
// STORE RESPONSE TYPES
// ============================================

export interface StoreResponse {
  success: boolean;
  message: string;
  data: StoreProfile;
}

export interface StoreWithSellerResponse {
  store: StoreProfile;
  seller: {
    id: string;
    legal_business_name: string;
    trading_name?: string;
    business_type: string;
    country: string;
    rating: number;
    total_reviews: number;
    fulfillment_rate: number;
    response_rate: number;
  };
}

export interface StoresListResponse {
  success: boolean;
  data: StoreProfile[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

// ============================================
// STORE QUERY TYPES
// ============================================

export interface GetStoresQuery {
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'created_at' | 'total_products' | 'total_orders' | 'average_rating';
  sortOrder?: 'asc' | 'desc';
  status?: StoreStatus[];
  category?: StoreCategory[];
  type?: StoreType[];
  seller_id?: string;
  is_active?: boolean;
  search?: string;
  has_products?: boolean;
  min_rating?: number;
  max_rating?: number;
  country?: string[];
  date_from?: Date;
  date_to?: Date;
}

// ============================================
// STORE METRICS (Analytics)
// ============================================

export interface StoreMetrics {
  store_id: string;
  period: 'today' | 'week' | 'month' | 'year' | 'all';
  
  // Traffic
  total_visits: number;
  unique_visitors: number;
  
  // Orders
  total_orders: number;
  completed_orders: number;
  cancelled_orders: number;
  refunded_orders: number;
  average_order_value: number;
  
  // Revenue
  total_revenue: number;
  revenue_by_currency: Record<string, number>;
  platform_fees: number;
  net_earnings: number;
  
  // Products
  total_products: number;
  active_products: number;
  out_of_stock_products: number;
  top_selling_products: Array<{
    product_id: string;
    name: string;
    units_sold: number;
    revenue: number;
  }>;
  
  // Customer satisfaction
  average_rating: number;
  total_reviews: number;
  positive_reviews: number;
  negative_reviews: number;
  
  // Conversion
  conversion_rate: number;
  bounce_rate: number;
}

// ============================================
// STORE ONBOARDING (Seller-side, not moderation)
// ============================================

export interface StoreOnboardingProgress {
  steps: {
    step: 'basic_info' | 'branding' | 'policies' | 'products' | 'publish';
    label: string;
    completed: boolean;
    required: boolean;
    error?: string;
  }[];
  isComplete: boolean;
  currentStep: 'basic_info' | 'branding' | 'policies' | 'products' | 'publish';
  missingFields: string[];
}

// ============================================
// STORE API RESPONSE
// ============================================

export interface StoreApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
  request_id?: string;
  timestamp: string;
  metadata?: {
    processing_time_ms?: number;
    cache_hit?: boolean;
  };
}