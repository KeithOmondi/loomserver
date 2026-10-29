// src/features/catalog/variant.types.ts
import type { Timestamped, UUID } from './common.types';
import type { AttributeDefinition, AttributeOption } from './attribute.types';

export type VariantStockStatus =
  | 'in_stock'
  | 'out_of_stock'
  | 'backorder'
  | 'preorder'
  | 'discontinued';

export type VariantWeightUnit = 'kg' | 'g' | 'lb' | 'oz';

export interface ProductVariant extends Timestamped {
  id: UUID;
  product_id: UUID;
  sku: string;

  price: number;
  compare_at_price: number | null;
  cost_per_item: number | null;

  stock_quantity: number;
  stock_status: VariantStockStatus;
  low_stock_threshold: number;
  allow_backorders: boolean;

  weight: number | null;
  weight_unit: VariantWeightUnit | null;
  image_url: string | null;

  position: number;
  is_active: boolean;
  metadata: Record<string, unknown> | null;
}

export interface VariantAttributeValue {
  id: UUID;
  variant_id: UUID;
  attribute_id: UUID;
  value_option_id: UUID;
}

export interface VariantAttributeValueWithDetails
  extends VariantAttributeValue {
  attribute: AttributeDefinition;
  option: AttributeOption;
}

export interface ProductVariantWithAttributes extends ProductVariant {
  attributes: VariantAttributeValueWithDetails[];
}

export interface CreateVariantInput {
  sku: string;
  price: number;
  compare_at_price?: number;
  cost_per_item?: number;
  stock_quantity: number;
  stock_status?: VariantStockStatus;
  low_stock_threshold?: number;
  allow_backorders?: boolean;
  weight?: number;
  weight_unit?: VariantWeightUnit;
  image_url?: string;
  position?: number;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
  attributes: { attribute_id: UUID; value_option_id: UUID }[];
}

export interface UpdateVariantInput {
  sku?: string;
  price?: number;
  compare_at_price?: number | null;
  cost_per_item?: number | null;
  stock_quantity?: number;
  stock_status?: VariantStockStatus;
  low_stock_threshold?: number;
  allow_backorders?: boolean;
  weight?: number | null;
  weight_unit?: VariantWeightUnit | null;
  image_url?: string | null;
  position?: number;
  is_active?: boolean;
  metadata?: Record<string, unknown> | null;
  attributes?: { attribute_id: UUID; value_option_id: UUID }[];
}