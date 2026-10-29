// src/features/catalog/attribute.types.ts
import type { Timestamped, UUID } from './common.types';

// ============================================
// Enums
// ============================================

export type AttributeType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multiselect';

export type AttributeScope = 'global' | 'category';

// ============================================
// Validation rules (JSONB column)
// ============================================

export interface AttributeValidation {
  min_length?: number;
  max_length?: number;
  min?: number;
  max?: number;
  regex?: string;
  /** Unit label for number/date: "cm", "kg", "GB". */
  unit?: string;
}

// ============================================
// Attribute group
// ============================================

export interface AttributeGroup extends Timestamped {
  id: UUID;
  name: string;
  slug: string;
  description: string | null;
  sort_order: number;
}

// ============================================
// Attribute definition
// ============================================

export interface AttributeDefinition extends Timestamped {
  id: UUID;
  name: string;
  slug: string;
  description: string | null;

  type: AttributeType;
  scope: AttributeScope;

  /** UI grouping. */
  group_id: UUID | null;

  /** Default requirement; CategoryAttributeSet can override. */
  is_required: boolean;

  is_filterable: boolean;
  /** True when used to build variants (Color, Size). */
  is_variant: boolean;
  /** Show in comparison tables / search. */
  is_comparable: boolean;
  is_searchable: boolean;

  validation: AttributeValidation;

  sort_order: number;
  is_active: boolean;
}

// ============================================
// Attribute option (for select / multiselect)
// ============================================

export interface AttributeOption extends Timestamped {
  id: UUID;
  attribute_id: UUID;
  value: string;
  slug: string;
  /** Optional swatch (hex) for color-like attributes. */
  swatch: string | null;
  sort_order: number;
  is_active: boolean;
}

// ============================================
// Attribute set (reusable bundle of attributes)
// ============================================

export interface AttributeSet extends Timestamped {
  id: UUID;
  name: string;
  slug: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface AttributeSetItem {
  id: UUID;
  set_id: UUID;
  attribute_id: UUID;
  /** Per-set overrides. Null = inherit from AttributeDefinition. */
  is_required_override: boolean | null;
  is_filterable_override: boolean | null;
  sort_order: number;
}

export interface AttributeSetWithItems extends AttributeSet {
  items: Array<
    AttributeSetItem & {
      attribute: AttributeDefinition;
      options: AttributeOption[];
    }
  >;
}