// src/features/catalog/product-attribute.service.ts

import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import type {
  ProductAttributeInput,
  ProductAttributeValueWithDetails,
} from './product-attribute.types';

// ============================================
// TYPES
// ============================================

interface CategoryAttributeDefinition {
  attribute_id: string;
  attribute_type: string;
  is_required: boolean;
  options: Set<string>; // option UUIDs allowed for this attribute
}

// ============================================
// INTERNAL: load the category's attribute contract
// ============================================

/**
 * Fetch the attribute definitions linked to a category (via
 * category_attributes), including the option IDs allowed for select
 * attributes. Used to validate incoming product attributes.
 *
 * Runs inside the caller's transaction — pass the PoolClient.
 */
const loadCategoryContract = async (
  client: PoolClient,
  categoryId: string,
): Promise<Map<string, CategoryAttributeDefinition>> => {
  const result = await client.query<{
    attribute_id: string;
    attribute_type: string;
    is_required: boolean;
    option_ids: string[] | null;
  }>(
    `SELECT
       ca.attribute_id,
       ad.type          AS attribute_type,
       ca.is_required,
       COALESCE(
         ARRAY_AGG(ao.id) FILTER (WHERE ao.id IS NOT NULL),
         ARRAY[]::uuid[]
       ) AS option_ids
     FROM category_attributes ca
     JOIN attribute_definitions ad ON ad.id = ca.attribute_id
     LEFT JOIN attribute_options ao ON ao.attribute_id = ad.id
     WHERE ca.category_id = $1
     GROUP BY ca.attribute_id, ad.type, ca.is_required`,
    [categoryId],
  );

  const contract = new Map<string, CategoryAttributeDefinition>();
  for (const row of result.rows) {
    contract.set(row.attribute_id, {
      attribute_id: row.attribute_id,
      attribute_type: row.attribute_type,
      is_required: row.is_required,
      options: new Set(row.option_ids ?? []),
    });
  }
  return contract;
};

// ============================================
// INTERNAL: per-attribute validation
// ============================================

/**
 * Ensures the value the client sent matches the attribute's declared type
 * and — for select attributes — that the option belongs to that attribute.
 */
const validateValueAgainstType = (
  input: ProductAttributeInput,
  def: CategoryAttributeDefinition,
): void => {
  const { attribute_type } = def;

  switch (attribute_type) {
    case 'text':
    case 'textarea':
      if (input.value_text === undefined) {
        throw new AppError(
          400,
          `Attribute ${input.attribute_id} requires value_text (type: ${attribute_type}).`,
        );
      }
      break;

    case 'number':
      if (input.value_number === undefined) {
        throw new AppError(
          400,
          `Attribute ${input.attribute_id} requires value_number.`,
        );
      }
      break;

    case 'boolean':
      if (input.value_boolean === undefined) {
        throw new AppError(
          400,
          `Attribute ${input.attribute_id} requires value_boolean.`,
        );
      }
      break;

    case 'date':
      if (input.value_date === undefined) {
        throw new AppError(
          400,
          `Attribute ${input.attribute_id} requires value_date.`,
        );
      }
      break;

    case 'select':
      if (input.value_option_id === undefined) {
        throw new AppError(
          400,
          `Attribute ${input.attribute_id} requires value_option_id.`,
        );
      }
      if (!def.options.has(input.value_option_id)) {
        throw new AppError(
          400,
          `value_option_id ${input.value_option_id} does not belong to attribute ${input.attribute_id}.`,
        );
      }
      break;

    case 'multiselect':
      // Not currently used in the schema, but handled for completeness
      if (input.value_option_ids === undefined || input.value_option_ids.length === 0) {
        throw new AppError(
          400,
          `Attribute ${input.attribute_id} requires value_option_ids.`,
        );
      }
      for (const optId of input.value_option_ids) {
        if (!def.options.has(optId)) {
          throw new AppError(
            400,
            `value_option_id ${optId} does not belong to attribute ${input.attribute_id}.`,
          );
        }
      }
      break;

    default:
      throw new AppError(
        500,
        `Unknown attribute type '${attribute_type}' for attribute ${input.attribute_id}.`,
      );
  }
};

// ============================================
// PUBLIC: validate + persist
// ============================================

/**
 * Validate and persist product attribute values.
 *
 * Called inside `createProduct` / `updateProduct` after the product row is
 * inserted/updated, within the same transaction.
 *
 * Semantics:
 *  - If `attributes` is `undefined`, this is a no-op (create path with no attrs).
 *  - If `attributes` is `[]`, all existing rows are deleted (update path clears).
 *  - If `attributes` is non-empty, existing rows are replaced by the new set.
 *  - Every required attribute for the category MUST be present.
 *  - Every provided attribute MUST be linked to the category.
 *
 * @param client      Transaction-scoped PoolClient
 * @param productId   The product UUID (already inserted/updated)
 * @param categoryId  The product's category (nullable)
 * @param attributes  The validated array from `productAttributeInputSchema`
 */
export const persistProductAttributes = async (
  client: PoolClient,
  productId: string,
  categoryId: string | null,
  attributes: ProductAttributeInput[] | undefined,
): Promise<void> => {
  // No attributes array → nothing to do
  if (attributes === undefined) return;

  // No category → reject any attributes (they can't be validated)
  if (!categoryId) {
    if (attributes.length > 0) {
      throw new AppError(
        400,
        'Cannot set attributes: product has no category.',
      );
    }
    // Empty array + no category: delete any existing rows (safe no-op)
    await client.query(
      `DELETE FROM product_attribute_values WHERE product_id = $1`,
      [productId],
    );
    return;
  }

  // Load the category's contract
  const contract = await loadCategoryContract(client, categoryId);

  if (contract.size === 0 && attributes.length > 0) {
    throw new AppError(
      400,
      'Category has no attributes defined; cannot set attributes.',
    );
  }

  // Reject attributes not linked to this category
  for (const input of attributes) {
    if (!contract.has(input.attribute_id)) {
      throw new AppError(
        400,
        `Attribute ${input.attribute_id} is not valid for this category.`,
      );
    }
  }

  // Enforce required attributes
  const providedIds = new Set(attributes.map((a) => a.attribute_id));
  const missing: string[] = [];
  for (const [attrId, def] of contract) {
    if (def.is_required && !providedIds.has(attrId)) {
      missing.push(attrId);
    }
  }
  if (missing.length > 0) {
    // Look up names for a nicer error
    const namesResult = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM attribute_definitions WHERE id = ANY($1::uuid[])`,
      [missing],
    );
    const names = namesResult.rows.map((r) => r.name).join(', ');
    throw new AppError(
      400,
      `Missing required attributes: ${names}`,
    );
  }

  // Validate each value against its declared type
  for (const input of attributes) {
    const def = contract.get(input.attribute_id)!;
    validateValueAgainstType(input, def);
  }

  // Replace semantics: delete existing rows for this product, then insert
  await client.query(
    `DELETE FROM product_attribute_values WHERE product_id = $1`,
    [productId],
  );

  if (attributes.length === 0) return;

  // Batch insert
  const columns = [
    'product_id',
    'attribute_id',
    'value_text',
    'value_number',
    'value_boolean',
    'value_date',
    'value_option_id',
  ];

  const placeholders: string[] = [];
  const values: unknown[] = [];
  let p = 1;

  for (const attr of attributes) {
    placeholders.push(
      `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
    );
    values.push(
      productId,
      attr.attribute_id,
      attr.value_text ?? null,
      attr.value_number ?? null,
      attr.value_boolean ?? null,
      attr.value_date ?? null,
      attr.value_option_id ?? null,
    );
  }

  await client.query(
    `INSERT INTO product_attribute_values (${columns.join(', ')})
     VALUES ${placeholders.join(', ')}`,
    values,
  );
};

// ============================================
// PUBLIC: read attributes for a product
// ============================================

/**
 * Fetch all attributes attached to a product, with attribute metadata
 * and resolved option details (for select/multiselect).
 *
 * Use this when shaping a product detail response.
 */
export const getProductAttributes = async (
  productId: string,
  client?: PoolClient,
): Promise<ProductAttributeValueWithDetails[]> => {
  const q = client ?? pool;

  const result = await q.query(
    `SELECT
       pav.id,
       pav.product_id,
       pav.attribute_id,
       pav.value_text,
       pav.value_number,
       pav.value_boolean,
       pav.value_date,
       pav.value_option_id,
       pav.created_at,
       pav.updated_at,

       ad.name  AS attribute_name,
       ad.slug  AS attribute_slug,
       ad.type  AS attribute_type,

       ao.id        AS option_id,
       ao.value     AS option_value,
       ao.slug      AS option_slug
     FROM product_attribute_values pav
     JOIN attribute_definitions ad ON ad.id = pav.attribute_id
     LEFT JOIN attribute_options ao ON ao.id = pav.value_option_id
     WHERE pav.product_id = $1
     ORDER BY ad.name ASC`,
    [productId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    product_id: row.product_id,
    attribute_id: row.attribute_id,
    value_text: row.value_text,
    value_number: row.value_number !== null ? Number(row.value_number) : null,
    value_boolean: row.value_boolean,
    value_date: row.value_date ? new Date(row.value_date) : null,
    value_option_id: row.value_option_id,
    value_option_ids: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    attribute: {
      id: row.attribute_id,
      name: row.attribute_name,
      slug: row.attribute_slug,
      type: row.attribute_type,
    } as any,
    option: row.option_id
      ? {
          id: row.option_id,
          value: row.option_value,
          slug: row.option_slug,
          swatch: null, // ⚠️ no swatch column yet — placeholder until schema adds it
        } as any
      : undefined,
  }));
};