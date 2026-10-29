// src/features/catalog/category-attribute.types.ts
import type { Timestamped, UUID } from './common.types';
import type {
  AttributeDefinition,
  AttributeOption,
  AttributeSet,
} from './attribute.types';

// ============================================
// Category ↔ AttributeSet assignment
// ============================================

/**
 * Direct assignment of an AttributeSet to a Category.
 * Inheritance is resolved by walking up the category tree.
 */
export interface CategoryAttributeSet extends Timestamped {
  id: UUID;
  category_id: UUID;
  set_id: UUID;
  /** If true, descendants inherit this set. */
  is_inherited_by_children: boolean;
  sort_order: number;
}

export interface CategoryAttributeSetWithDetails
  extends CategoryAttributeSet {
  set: AttributeSet;
}

// ============================================
// Effective attributes (post-inheritance)
// ============================================

/** Summary row used in CategoryWithAttributes. */
export interface CategoryAttributeSetSummary {
  set_id: UUID;
  set_slug: string;
  set_name: string;
  is_inherited: boolean;
  /** Category this set was inherited from (null if assigned directly). */
  inherited_from_category_id: UUID | null;
}

/** Fully-resolved attribute for a category, ready for form rendering. */
export interface EffectiveCategoryAttribute {
  attribute: AttributeDefinition;
  options: AttributeOption[];

  /** Resolved requirement (set override wins over definition default). */
  is_required: boolean;
  is_filterable: boolean;

  sort_order: number;

  /** Where this attribute came from in the tree. */
  source: {
    set_id: UUID;
    set_slug: string;
    category_id: UUID;
    category_slug: string;
    is_inherited: boolean;
  };
}