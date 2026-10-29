// src/features/catalog/category.types.ts
import type { Timestamped, UUID } from '../catalog/common.types';

// ============================================
// Enums
// ============================================

export type CategoryStatus = 'active' | 'inactive' | 'archived';

/**
 * Explicit category role. Prevents the "can this node hold products?" ambiguity.
 * - department: top-level (e.g., Electronics)
 * - category:   second level (e.g., Phones)
 * - subcategory: third level (e.g., Smartphones)
 * - leaf:       final node that products attach to
 */
export type CategoryType = 'department' | 'category' | 'subcategory' | 'leaf';

// ============================================
// SEO
// ============================================

export interface CategorySeo {
  meta_title: string | null;
  meta_description: string | null;
  meta_keywords: string | null;
  canonical_url: string | null;
  og_image_url: string | null;
}

// ============================================
// Core entity
// ============================================

export interface Category extends Timestamped {
  id: UUID;
  parent_id: UUID | null;

  name: string;
  slug: string;
  description: string | null;

  /** Materialized path (Postgres ltree), e.g. "electronics.phones.smartphones". */
  path: string;
  /** Depth from root. Root = 0. */
  depth: number;
  /** True when this node is allowed to hold products. */
  is_leaf: boolean;
  /** Explicit role. Kept in sync with depth/leaf by the service layer. */
  type: CategoryType;

  image_url: string | null;
  icon: string | null;

  sort_order: number;
  status: CategoryStatus;
  is_featured: boolean;

  seo: CategorySeo;

  /** Denormalized counters for fast reads. Updated by triggers/jobs. */
  product_count: number;
  child_count: number;

  created_by: UUID | null;
}

// ============================================
// Derived shapes
// ============================================

/** Tree node returned by tree endpoints. */
export interface CategoryNode extends Category {
  children: CategoryNode[];
  /** Human-readable breadcrumb, e.g. "Electronics / Phones / Smartphones". */
  full_path: string;
}

/**
 * Category + the individual attribute definitions linked to it.
 *
 * NOTE: this is the wire shape returned by
 *   GET /api/v1/categories/:id/attributes
 * and is what the seller Add Product form consumes.
 *
 * The actual shape (with `category` + `attributes` keys) is defined in
 * `category.service.ts` as `CategoryWithAttributes`. This alias exists only
 * so consumers can import a single name from this file if they prefer.
 */
export type { CategoryWithAttributes } from './category.service';

// ============================================
// Filter shape (DB-facing; validator owns HTTP shape)
// ============================================

export interface CategoryFilters {
  parent_id?: UUID | null;
  /** Query root-only categories (parent_id IS NULL). */
  parent_id_is_null?: boolean;
  type?: CategoryType;
  status?: CategoryStatus;
  is_featured?: boolean;
  is_leaf?: boolean;
  search?: string;
  /** Include descendants of `parent_id` (uses ltree). */
  include_descendants?: boolean;
  depth_max?: number;
  sort?: 'name' | 'sort_order' | 'created_at' | 'product_count';
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

// ============================================
// Deprecated input types (kept for back-compat)
// ============================================
//
// ⚠️  The validator (`category.validator.ts`) is now the source of truth for
//     request shapes. These types remain only so older code compiles.
//     New code should import the inferred types from the validator:
//
//       import type {
//         CreateCategoryBody,
//         UpdateCategoryBody,
//         CategoryQuery,
//       } from './category.validator';

/** @deprecated Use `CreateCategoryBody` from `category.validator.ts`. */
export interface CreateCategoryInput {
  parent_id?: UUID | null;
  name: string;
  slug?: string;
  description?: string;
  type?: CategoryType;
  image_url?: string;
  icon?: string;
  sort_order?: number;
  status?: CategoryStatus;
  is_featured?: boolean;
  seo?: Partial<CategorySeo>;
}

/** @deprecated Use `UpdateCategoryBody` from `category.validator.ts`. */
export interface UpdateCategoryInput {
  parent_id?: UUID | null;
  name?: string;
  slug?: string;
  description?: string | null;
  type?: CategoryType;
  image_url?: string | null;
  icon?: string | null;
  sort_order?: number;
  status?: CategoryStatus;
  is_featured?: boolean;
  seo?: Partial<CategorySeo>;
}

// ============================================
// Backwards-compat aliases
// ============================================

/** @deprecated Use `CategoryNode`. */
export type CategoryWithChildren = CategoryNode;

/** Matches the validator's `CategoryListItem`. */
export type CategoryListItem = Category;

/** Matches the validator's `CategoryDetailResponse`. */
export interface CategoryDetailResponse extends Category {
  seo: CategorySeo;
  created_by: UUID | null;
}