// src/features/catalog/product.types.ts
import type { Timestamped, UUID, StoreSummary } from "../catalog/common.types";
import type { Category } from "../categories/category.types";
import type {
  ProductVariantWithAttributes,
  CreateVariantInput,
  UpdateVariantInput,
} from "../catalog/variant.types";
import {
  AttributeFilterInput,
  ProductAttributeInput,
  ProductAttributeValueWithDetails,
} from "../catalog/product-attribute.types";

// ============================================
// ENUMS
// ============================================

export enum ProductStatus {
  DRAFT = "draft",
  PENDING = "pending",
  ACTIVE = "active",
  SUSPENDED = "suspended",
  REJECTED = "rejected",
  DISCONTINUED = "discontinued",
}

export enum StockStatus {
  IN_STOCK = "in_stock",
  OUT_OF_STOCK = "out_of_stock",
  BACKORDER = "backorder",
  PREORDER = "preorder",
  DISCONTINUED = "discontinued",
}

export enum ProductType {
  PHYSICAL = "physical",
  DIGITAL = "digital",
  SERVICE = "service",
  SUBSCRIPTION = "subscription",
}

export enum WeightUnit {
  KG = "kg",
  G = "g",
  LB = "lb",
  OZ = "oz",
}

export enum ProductCondition {
  NEW = "new",
  USED_LIKE_NEW = "used_like_new",
  USED_GOOD = "used_good",
  USED_FAIR = "used_fair",
  REFURBISHED = "refurbished",
}

export enum ProductVisibility {
  PUBLIC = "public",
  PRIVATE = "private",
  UNLISTED = "unlisted",
}

export enum ReviewStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
  FLAGGED = "flagged",
}

// ============================================
// STATUS UNIONS — seller vs moderator flows
// ============================================

export type SellerCreatableStatus = ProductStatus.DRAFT | ProductStatus.PENDING;

export type SellerMutableStatus =
  | ProductStatus.DRAFT
  | ProductStatus.PENDING
  | ProductStatus.DISCONTINUED;

export type SellerProductStatusFilter =
  | ProductStatus.DRAFT
  | ProductStatus.PENDING
  | ProductStatus.ACTIVE
  | ProductStatus.REJECTED
  | ProductStatus.SUSPENDED
  | ProductStatus.DISCONTINUED;

export type ModeratorQueueStatus = ProductStatus.PENDING | ProductStatus.DRAFT;

// ============================================
// LIFECYCLE STATE MACHINE
// ============================================

export const PRODUCT_STATUS_TRANSITIONS: Record<
  ProductStatus,
  ProductStatus[]
> = {
  [ProductStatus.DRAFT]: [ProductStatus.PENDING, ProductStatus.DISCONTINUED],
  [ProductStatus.PENDING]: [
    ProductStatus.DRAFT,
    ProductStatus.ACTIVE,
    ProductStatus.REJECTED,
  ],
  [ProductStatus.ACTIVE]: [ProductStatus.SUSPENDED, ProductStatus.DISCONTINUED],
  [ProductStatus.REJECTED]: [ProductStatus.DRAFT, ProductStatus.PENDING],
  [ProductStatus.SUSPENDED]: [ProductStatus.ACTIVE, ProductStatus.DISCONTINUED],
  [ProductStatus.DISCONTINUED]: [],
};

export function canTransition(from: ProductStatus, to: ProductStatus): boolean {
  return PRODUCT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================
// SEO (mirrors CategorySeo)
// ============================================

export interface ProductSeo {
  meta_title: string | null;
  meta_description: string | null;
  meta_keywords: string | null;
  canonical_url: string | null;
  og_image_url: string | null;
}

// ============================================
// COMPOSITE SHAPES
// ============================================

export interface ProductDimensions {
  length: number;
  width: number;
  height: number;
  unit: "cm" | "in";
}

export interface ProductImage {
  id: UUID;
  product_id: UUID;
  url: string;
  public_id: string;
  alt_text: string | null;
  is_primary: boolean;
  sort_order: number;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface ProductReview {
  id: UUID;
  product_id: UUID;
  user_id: UUID;
  order_id: UUID | null;
  rating: number;
  title: string | null;
  comment: string | null;
  images: string[] | null;
  is_verified_purchase: boolean;
  is_approved: boolean;
  status: ReviewStatus;
  helpful_count: number;
  moderated_by: UUID | null;
  moderated_at: Date | null;
  moderation_reason: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;

  user?: {
    id: UUID;
    full_name: string;
    avatar_url: string | null;
  };
}

export interface ProductStockHistory {
  id: UUID;
  product_id: UUID;
  variant_id: UUID | null;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  reason: "purchase" | "return" | "restock" | "adjustment" | "cancellation";
  reference_id: UUID | null;
  created_at: Date;
  created_by: UUID;
}

// ============================================
// CORE ENTITY
// ============================================

export interface Product extends Timestamped {
  id: UUID;
  store_id: UUID;
  seller_id: UUID;

  // Content
  name: string;
  slug: string;
  description: string | null;
  short_description: string | null;
  tags: string[];

  // Classification
  type: ProductType;
  condition: ProductCondition;
  visibility: ProductVisibility;
  category_id: UUID | null;

  // Pricing
  price: number;
  compare_at_price: number | null;
  cost_per_item: number | null;
  tax_class: string | null;
  is_taxable: boolean;

  // Inventory
  sku: string | null;
  barcode: string | null;
  stock_quantity: number;
  stock_status: StockStatus;
  low_stock_threshold: number;
  allow_backorders: boolean;
  allow_preorders: boolean;
  preorder_release_date: Date | null;

  // Physical shipping
  weight: number | null;
  weight_unit: WeightUnit;
  dimensions: ProductDimensions | null;
  requires_shipping: boolean;
  shipping_class: string | null;

  // Media
  video_url: string | null;

  // Variants
  has_variants: boolean;
  /** Attribute ids used for variant generation (e.g., [color, size]). */
  variant_attribute_ids: UUID[];

  // Digital
  digital_file_url: string | null;
  digital_file_size: number | null;
  digital_file_name: string | null;
  license_key: string | null;

  // SEO
  seo: ProductSeo;

  // Lifecycle / moderation
  status: ProductStatus;
  is_active: boolean;
  is_approved: boolean;
  is_featured: boolean;
  rejection_reason: string | null;
  moderated_at: Date | null;
  moderated_by: UUID | null;
  moderation_notes: string | null;

  // Counters
  view_count: number;
  wishlist_count: number;
  order_count: number;
  average_rating: number;
  total_reviews: number;
  sales_count: number;

  // Timestamps (extra beyond Timestamped)
  published_at: Date | null;
  deleted_at: Date | null;

  metadata: Record<string, unknown> | null;
}

// ============================================
// HYDRATED SHAPES
// ============================================

export interface ProductWithDetails extends Product {
  images: ProductImage[];
  attributes: ProductAttributeValueWithDetails[];
  variants: ProductVariantWithAttributes[];

  store?: StoreSummary;
  seller?: {
    id: UUID;
    legal_business_name: string;
    trading_name: string | null;
    rating: number;
  };
  category?: Category;
  reviews?: ProductReview[];
}

export interface ModerationProductSnapshot {
  product: Product;
  store?: {
    id: UUID;
    name: string;
    slug: string;
  };
  seller?: {
    id: UUID;
    legal_business_name: string;
    trading_name: string | null;
    user?: {
      id: UUID;
      full_name: string;
      email: string;
    };
  };
  stats?: {
    views: number;
    wishlist_count: number;
    order_count: number;
    average_rating: number;
    total_reviews: number;
  };
  moderation_history?: Array<{
    id: UUID;
    moderator_id: UUID;
    moderator_name?: string;
    action: "approved" | "rejected" | "suspended";
    notes?: string;
    reason?: string;
    created_at: Date;
  }>;
}

// ============================================
// INPUTS — SELLER
// ============================================

export interface CreateProductInput {
  store_id: UUID;
  seller_id: UUID;

  name: string;
  slug?: string;
  description?: string | null;
  short_description?: string | null;

  type: ProductType;
  condition?: ProductCondition;
  visibility?: ProductVisibility;

  category_id?: UUID | null;
  tags?: string[];

  price: number;
  compare_at_price?: number | null;
  cost_per_item?: number | null;
  tax_class?: string | null;
  is_taxable?: boolean;

  sku?: string | null;
  barcode?: string | null;
  stock_quantity?: number;
  stock_status?: StockStatus;
  low_stock_threshold?: number;
  allow_backorders?: boolean;
  allow_preorders?: boolean;
  preorder_release_date?: Date | null;

  weight?: number | null;
  weight_unit?: WeightUnit;
  dimensions?: ProductDimensions | null;
  requires_shipping?: boolean;
  shipping_class?: string | null;

  video_url?: string | null;

  has_variants?: boolean;
  /** Attribute ids selected as variant generators. */
  variant_attribute_ids?: UUID[];

  digital_file_url?: string | null;
  digital_file_size?: number | null;
  digital_file_name?: string | null;

  seo?: Partial<ProductSeo>;

  /** EAV attribute values (brand, material, etc). */
  attributes?: ProductAttributeInput[];

  /** Variants when `has_variants = true`. */
  variants?: CreateVariantInput[];

  /** Multer files — service uploads to Cloudinary/S3 first. */
  images?: Express.Multer.File[];

  status?: SellerCreatableStatus;
  is_featured?: boolean;

  metadata?: Record<string, unknown>;
}

export interface UpdateProductInput {
  name?: string;
  slug?: string;
  description?: string | null;
  short_description?: string | null;

  type?: ProductType;
  condition?: ProductCondition;
  visibility?: ProductVisibility;

  category_id?: UUID | null;
  tags?: string[];

  price?: number;
  compare_at_price?: number | null;
  cost_per_item?: number | null;
  tax_class?: string | null;
  is_taxable?: boolean;

  sku?: string | null;
  barcode?: string | null;
  stock_quantity?: number;
  stock_status?: StockStatus;
  low_stock_threshold?: number;
  allow_backorders?: boolean;
  allow_preorders?: boolean;
  preorder_release_date?: Date | null;

  weight?: number | null;
  weight_unit?: WeightUnit;
  dimensions?: ProductDimensions | null;
  requires_shipping?: boolean;
  shipping_class?: string | null;

  video_url?: string | null;

  has_variants?: boolean;
  variant_attribute_ids?: UUID[];

  digital_file_url?: string | null;
  digital_file_size?: number | null;
  digital_file_name?: string | null;

  seo?: Partial<ProductSeo>;

  attributes?: ProductAttributeInput[];
  variants?: UpdateVariantInput[];

  /** ✅ NEW: Multer files — service uploads to Cloudinary/S3 first. */
  images?: Express.Multer.File[];

  status?: SellerMutableStatus;
  is_featured?: boolean;
  is_active?: boolean;

  metadata?: Record<string, unknown>;
}

// ============================================
// INPUTS — MODERATOR
// ============================================

export interface ModerateProductInput {
  approved: boolean;
  rejection_reason?: string;
  notes?: string;
}

// ============================================
// QUERIES
// ============================================

export type ProductSort =
  | "name"
  | "price_asc"
  | "price_desc"
  | "newest"
  | "oldest"
  | "popular"
  | "rating"
  | "sales"
  | "relevance";

export interface GetProductsQuery {
  page?: number;
  limit?: number;
  search?: string;

  status?: ProductStatus[];
  type?: ProductType;
  condition?: ProductCondition;

  category_id?: UUID;
  /** Include descendants of category_id (ltree). */
  category_include_descendants?: boolean;

  store_id?: UUID;
  seller_id?: UUID;

  min_price?: number;
  max_price?: number;

  has_variants?: boolean;
  is_active?: boolean;
  is_approved?: boolean;
  is_featured?: boolean;
  in_stock?: boolean;

  /** Typed attribute filters OR legacy record form. */
  attributes?: AttributeFilterInput;

  sort?: ProductSort;
  order?: "asc" | "desc";

  date_from?: Date;
  date_to?: Date;
}

// ============================================
// RESPONSES
// ============================================

export interface ProductListResponse {
  items: ProductWithDetails[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  filters?: {
    categories: Array<{ id: UUID; name: string; count: number }>;
    statuses: Array<{ status: ProductStatus; count: number }>;
    price_range: { min: number; max: number };
  };
}

export interface ProductMetrics {
  product_id: UUID;
  period: "today" | "week" | "month" | "year" | "all";
  views: number;
  wishlist_count: number;
  order_count: number;
  revenue: number;
  average_rating: number;
  total_reviews: number;
  conversion_rate: number;
  return_rate: number;
}

// ============================================
// REVIEWS
// ============================================

export interface CreateProductReviewInput {
  product_id: UUID;
  order_id?: UUID;
  rating: number;
  title?: string;
  comment?: string;
  images?: string[];
}

export interface ModerateProductReviewInput {
  approved: boolean;
  reason?: string;
}

export interface ProductReviewsResponse {
  items: ProductReview[];
  summary: {
    average_rating: number;
    total_reviews: number;
    rating_distribution: Record<number, number>;
  };
  total: number;
  page: number;
  limit: number;
  pages: number;
}

// ============================================
// DERIVED-FIELD HELPERS
// ============================================

export function deriveStockStatus(args: {
  stock_quantity: number;
  allow_backorders?: boolean;
  allow_preorders?: boolean;
  current?: StockStatus;
}): StockStatus {
  const {
    stock_quantity,
    allow_backorders = false,
    allow_preorders = false,
    current,
  } = args;

  if (current === StockStatus.DISCONTINUED) return StockStatus.DISCONTINUED;
  if (current === StockStatus.PREORDER || allow_preorders) {
    return stock_quantity > 0 ? StockStatus.IN_STOCK : StockStatus.PREORDER;
  }
  if (stock_quantity > 0) return StockStatus.IN_STOCK;
  if (allow_backorders) return StockStatus.BACKORDER;
  return StockStatus.OUT_OF_STOCK;
}

export function deriveIsActive(status: ProductStatus): boolean {
  return status === ProductStatus.ACTIVE;
}

export function deriveIsApproved(status: ProductStatus): boolean {
  return status === ProductStatus.ACTIVE;
}

// ============================================
// CONSTANTS
// ============================================

export const ALL_PRODUCT_STATUSES = Object.values(ProductStatus);
export const ALL_STOCK_STATUSES = Object.values(StockStatus);
export const ALL_PRODUCT_TYPES = Object.values(ProductType);
export const ALL_PRODUCT_CONDITIONS = Object.values(ProductCondition);
export const ALL_PRODUCT_VISIBILITIES = Object.values(ProductVisibility);
export const ALL_WEIGHT_UNITS = Object.values(WeightUnit);

export const SELLER_CREATABLE_STATUSES: SellerCreatableStatus[] = [
  ProductStatus.DRAFT,
  ProductStatus.PENDING,
];

export const SELLER_MUTABLE_STATUSES: SellerMutableStatus[] = [
  ProductStatus.DRAFT,
  ProductStatus.PENDING,
  ProductStatus.DISCONTINUED,
];
