// src/features/catalog/product-attribute.types.ts
import type { Timestamped, UUID } from './common.types';
import type { AttributeDefinition, AttributeOption } from './attribute.types';

export interface ProductAttributeValue extends Timestamped {
  id: UUID;
  product_id: UUID;
  attribute_id: UUID;

  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: Date | null;

  value_option_id: UUID | null;
  value_option_ids: UUID[] | null;
}

export interface ProductAttributeValueWithDetails
  extends ProductAttributeValue {
  attribute: AttributeDefinition;
  option?: AttributeOption;
  options?: AttributeOption[];
}

export interface ProductAttributeInput {
  attribute_id: UUID;
  value_text?: string;
  value_number?: number;
  value_boolean?: boolean;
  value_date?: Date;
  value_option_id?: UUID;
  value_option_ids?: UUID[];
}

export type AttributeFilter =
  | { type: 'select'; slug: string; values: string[] }
  | {
      type: 'multiselect';
      slug: string;
      values: string[];
      match?: 'any' | 'all';
    }
  | { type: 'number'; slug: string; min?: number; max?: number }
  | { type: 'boolean'; slug: string; value: boolean }
  | { type: 'date'; slug: string; from?: Date; to?: Date }
  | { type: 'text'; slug: string; query: string }
  | { type: 'exists'; slug: string; exists: boolean };

export type AttributeFilterRecord = Record<
  string,
  | string
  | string[]
  | boolean
  | { min?: number; max?: number; from?: Date; to?: Date }
>;

export type AttributeFilterInput = AttributeFilter[] | AttributeFilterRecord;