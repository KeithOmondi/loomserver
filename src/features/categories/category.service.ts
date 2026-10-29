// src/features/catalog/category.service.ts
import { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import { redisService } from '../../config/redis';

import type {
  Category,
  CategoryNode,
} from './category.types';

import type {
  CreateCategoryBody,
  UpdateCategoryBody,
  MoveCategoryBody,
  ReorderCategoriesBody,
  BulkCategoryStatusBody,
  BulkCategoryDeleteBody,
  CategoryQuery,
  CategoryTreeQuery,
} from './category.validator';

// ============================================
// Constants
// ============================================

const CACHE_TTL = 3600; // 1 hour
const MAX_DEPTH = 5;
const CACHE_PREFIX = 'categories:';

const SORTABLE_COLUMNS = new Set([
  'name',
  'sort_order',
  'created_at',
  'product_count',
]);

// ============================================
// Helpers
// ============================================

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150);

const ensureSortColumn = (sort: string): string => {
  if (!SORTABLE_COLUMNS.has(sort)) {
    throw new AppError(400, `Invalid sort field: ${sort}`);
  }
  return sort;
};

const ensureDirection = (dir: string): 'ASC' | 'DESC' =>
  dir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

const invalidateCategoryCache = async (): Promise<void> => {
  await redisService.cacheDeletePattern(`${CACHE_PREFIX}*`);
};

// ============================================
// Low-level queries
// ============================================

export const findCategoryById = async (
  id: string,
  client?: PoolClient,
): Promise<Category | null> => {
  const q = client ?? pool;
  const result = await q.query<Category>(
    `SELECT * FROM categories WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
};

export const findCategoryBySlug = async (
  slug: string,
  client?: PoolClient,
): Promise<Category | null> => {
  const q = client ?? pool;
  const result = await q.query<Category>(
    `SELECT * FROM categories WHERE slug = $1`,
    [slug],
  );
  return result.rows[0] ?? null;
};

export const findCategoryByNameAtLevel = async (
  name: string,
  parentId: string | null,
  client?: PoolClient,
): Promise<Category | null> => {
  const q = client ?? pool;
  const result = await q.query<Category>(
    `SELECT * FROM categories
     WHERE name = $1 AND parent_id IS NOT DISTINCT FROM $2`,
    [name, parentId],
  );
  return result.rows[0] ?? null;
};

export const isDescendantOf = async (
  ancestorId: string,
  candidateId: string,
  client?: PoolClient,
): Promise<boolean> => {
  const q = client ?? pool;
  const result = await q.query<{ ok: boolean }>(
    `SELECT (SELECT path FROM categories WHERE id = $1)
            <@ (SELECT path FROM categories WHERE id = $2) AS ok`,
    [candidateId, ancestorId],
  );
  return result.rows[0]?.ok === true;
};

// ============================================
// Path / depth maintenance
// ============================================

/**
 * Compute path + depth (+ initial type) for a NEW node based on its parent.
 *
 * `is_leaf` is intentionally NOT depth-derived: a brand-new node always
 * starts with 0 children, so it is a leaf of its branch regardless of how
 * deep it sits (your real leaf tier lives at depth 2, not at MAX_DEPTH).
 * The moment it gains its own child, the parent-flip step in
 * createCategory() below sets is_leaf = false. `type` mirrors that same
 * signal for anything past the fixed department/category tiers, so type
 * and is_leaf can never disagree for a freshly created node.
 */
const computePathAndDepth = async (
  parentId: string | null,
  slug: string,
  client: PoolClient,
): Promise<{ path: string; depth: number; type: string }> => {
  if (!parentId) {
    return { path: slug, depth: 0, type: 'department' };
  }

  const parent = await findCategoryById(parentId, client);
  if (!parent) throw new AppError(404, 'Parent category not found.');

  const depth = parent.depth + 1;
  if (depth > MAX_DEPTH) {
    throw new AppError(400, `Category depth cannot exceed ${MAX_DEPTH}.`);
  }

  // depth 0 = department, depth 1 = category; anything deeper starts as
  // 'leaf' (it has no children yet) and gets relabelled 'subcategory'
  // once it gains one, via the same is_leaf flip that already happens
  // elsewhere in this file.
  const type = depth === 1 ? 'category' : 'leaf';

  return { path: `${parent.path}.${slug}`, depth, type };
};

/**
 * Recompute path/depth/type for the moved node AND its entire subtree in
 * a single UPDATE. `is_leaf` is deliberately left untouched here -- moving
 * a subtree doesn't change anyone's child_count, so leaf-ness doesn't
 * change either. `type` is recomputed from the *new* depth, falling back
 * to each row's existing is_leaf to decide 'leaf' vs 'subcategory' once
 * past the department/category tiers -- consistent with computePathAndDepth.
 */
const recomputeSubtree = async (
  oldPath: string,
  newPath: string,
  depthDelta: number,
  client: PoolClient,
): Promise<void> => {
  await client.query(
    `UPDATE categories
     SET
       path = $2::ltree || subpath(path, nlevel($1::ltree)),
       depth = depth + $3,
       type = CASE
                WHEN (depth + $3) = 0 THEN 'department'
                WHEN (depth + $3) = 1 THEN 'category'
                WHEN is_leaf THEN 'leaf'
                ELSE 'subcategory'
              END,
       updated_at = now()
     WHERE path <@ $1::ltree`,
    [oldPath, newPath, depthDelta],
  );
};

// ============================================
// Create
// ============================================

export const createCategory = async (
  input: CreateCategoryBody,
  userId: string,
): Promise<Category> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const parentId = input.parent_id ?? null;

    // 1. Duplicate name check at same level
    const existing = await findCategoryByNameAtLevel(input.name, parentId, client);
    if (existing) {
      throw new AppError(409, 'Category with this name already exists at this level.');
    }

    // 2. Slug (auto or provided) + uniqueness
    const baseSlug = input.slug ?? slugify(input.name);
    let slug = baseSlug;
    let suffix = 2;
    while (await findCategoryBySlug(slug, client)) {
      slug = `${baseSlug}-${suffix++}`;
    }

    // 3. Compute path/depth/type
    const { path, depth, type } = await computePathAndDepth(parentId, slug, client);

    // 4. Insert
    const result = await client.query<Category>(
      `INSERT INTO categories (
         parent_id, name, slug, description,
         path, depth, is_leaf, type,
         image_url, icon,
         sort_order, status, is_featured,
         seo, created_by
       ) VALUES (
         $1, $2, $3, $4,
         $5::ltree, $6, $7, $8,
         $9, $10,
         $11, $12, $13,
         $14::jsonb, $15
       )
       RETURNING *`,
      [
        parentId,
        input.name,
        slug,
        input.description ?? null,
        path,
        depth,
        true, // new nodes start with 0 children, so they start as leaves
        input.type ?? type,
        input.image_url ?? null,
        input.icon ?? null,
        input.sort_order ?? 0,
        input.status ?? 'active',
        input.is_featured ?? false,
        JSON.stringify(input.seo ?? {}),
        userId,
      ],
    );

    const created = result.rows[0];

    // 5. Flip parent to non-leaf + bump child_count
    if (parentId) {
      await client.query(
        `UPDATE categories
         SET is_leaf = false, child_count = child_count + 1, updated_at = now()
         WHERE id = $1`,
        [parentId],
      );
    }

    await client.query('COMMIT');
    await invalidateCategoryCache();
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ============================================
// Update
// ============================================

export const updateCategory = async (
  id: string,
  input: UpdateCategoryBody,
): Promise<Category> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await findCategoryById(id, client);
    if (!current) throw new AppError(404, 'Category not found.');

    // ---- Parent move (special path) ----
    if (input.parent_id !== undefined && input.parent_id !== current.parent_id) {
      await moveCategoryTx(
        id,
        { parent_id: input.parent_id ?? null },
        client,
      );
    }

    // ---- Slug change ----
    if (input.slug && input.slug !== current.slug) {
      const clash = await findCategoryBySlug(input.slug, client);
      if (clash && clash.id !== id) {
        throw new AppError(409, 'Slug already in use.');
      }
    }

    // ---- Name duplicate check ----
    if (input.name && input.name !== current.name) {
      const effectiveParent =
        input.parent_id !== undefined ? input.parent_id : current.parent_id;
      const dup = await findCategoryByNameAtLevel(
        input.name,
        effectiveParent,
        client,
      );
      if (dup && dup.id !== id) {
        throw new AppError(409, 'Category with this name already exists at this level.');
      }
    }

    // ---- Build dynamic SET ----
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    const set = (col: string, val: unknown) => {
      fields.push(`${col} = $${i++}`);
      values.push(val);
    };

    if (input.name !== undefined) set('name', input.name);
    if (input.slug !== undefined) set('slug', input.slug);
    if (input.description !== undefined) set('description', input.description);
    if (input.type !== undefined) set('type', input.type);
    if (input.image_url !== undefined) set('image_url', input.image_url);
    if (input.icon !== undefined) set('icon', input.icon);
    if (input.sort_order !== undefined) set('sort_order', input.sort_order);
    if (input.status !== undefined) set('status', input.status);
    if (input.is_featured !== undefined) set('is_featured', input.is_featured);
    if (input.seo !== undefined) set('seo', JSON.stringify(input.seo));

    if (fields.length) {
      fields.push('updated_at = now()');
      values.push(id);
      await client.query(
        `UPDATE categories SET ${fields.join(', ')} WHERE id = $${i}`,
        values,
      );
    }

    const updated = await findCategoryById(id, client);
    await client.query('COMMIT');
    await invalidateCategoryCache();
    return updated!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ============================================
// Move
// ============================================

const moveCategoryTx = async (
  id: string,
  body: MoveCategoryBody,
  client: PoolClient,
): Promise<void> => {
  const node = await findCategoryById(id, client);
  if (!node) throw new AppError(404, 'Category not found.');

  const newParentId = body.parent_id;

  if (newParentId === id) {
    throw new AppError(400, 'Category cannot be its own parent.');
  }

  // Prevent moving under own descendant
  if (newParentId && (await isDescendantOf(id, newParentId, client))) {
    throw new AppError(400, 'Cannot move category under its own descendant.');
  }

  const newParent = newParentId
    ? await findCategoryById(newParentId, client)
    : null;
  if (newParentId && !newParent) {
    throw new AppError(404, 'New parent not found.');
  }

  const { path: newPath, depth: newDepth } = await computePathAndDepth(
    newParentId,
    node.slug,
    client,
  );

  const depthDelta = newDepth - node.depth;
  const oldPath = node.path;

  // Guard against pushing a deeply-nested descendant past MAX_DEPTH.
  // The check on the moved node's own new depth (inside
  // computePathAndDepth) isn't enough -- a move that's fine for the node
  // itself can still be too deep for its deepest descendant, which would
  // otherwise surface as a raw categories_depth_check violation instead
  // of a clean 400.
  const { rows: depthRows } = await client.query<{ max_depth: number | null }>(
    `SELECT MAX(depth) AS max_depth FROM categories WHERE path <@ $1::ltree`,
    [oldPath],
  );
  const maxSubtreeDepth = depthRows[0]?.max_depth ?? node.depth;
  if (maxSubtreeDepth + depthDelta > MAX_DEPTH) {
    throw new AppError(
      400,
      `Moving this category would push its deepest descendant beyond the maximum depth of ${MAX_DEPTH}.`,
    );
  }

  await recomputeSubtree(oldPath, newPath, depthDelta, client);

  await client.query(
    `UPDATE categories
     SET parent_id = $1, sort_order = COALESCE($2, sort_order), updated_at = now()
     WHERE id = $3`,
    [newParentId, body.sort_order ?? null, id],
  );

  // Update old parent's leaf/child_count if it changed
  if (node.parent_id && node.parent_id !== newParentId) {
    await client.query(
      `UPDATE categories
       SET child_count = GREATEST(child_count - 1, 0),
           is_leaf = (child_count - 1) <= 0,
           updated_at = now()
       WHERE id = $1`,
      [node.parent_id],
    );
  }

  if (newParentId && node.parent_id !== newParentId) {
    await client.query(
      `UPDATE categories
       SET is_leaf = false, child_count = child_count + 1, updated_at = now()
       WHERE id = $1`,
      [newParentId],
    );
  }
};

export const moveCategory = async (
  id: string,
  body: MoveCategoryBody,
): Promise<Category> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await moveCategoryTx(id, body, client);
    const updated = await findCategoryById(id, client);
    await client.query('COMMIT');
    await invalidateCategoryCache();
    return updated!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ============================================
// Reorder siblings
// ============================================

export const reorderCategories = async (
  body: ReorderCategoriesBody,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let idx = 0; idx < body.ordered_ids.length; idx++) {
      await client.query(
        `UPDATE categories
         SET sort_order = $1, updated_at = now()
         WHERE id = $2 AND parent_id IS NOT DISTINCT FROM $3`,
        [idx, body.ordered_ids[idx], body.parent_id ?? null],
      );
    }
    await client.query('COMMIT');
    await invalidateCategoryCache();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ============================================
// Read
// ============================================

export const getCategoryById = async (id: string): Promise<Category | null> => {
  const cached = await redisService.cacheGet<Category>(`${CACHE_PREFIX}id:${id}`);
  if (cached) return cached;

  const category = await findCategoryById(id);
  if (category) {
    await redisService.cacheSet(`${CACHE_PREFIX}id:${id}`, category, CACHE_TTL);
  }
  return category;
};

export const getCategoryBySlug = async (slug: string): Promise<Category | null> => {
  const cached = await redisService.cacheGet<Category>(`${CACHE_PREFIX}slug:${slug}`);
  if (cached) return cached;

  const category = await findCategoryBySlug(slug);
  if (category) {
    await redisService.cacheSet(`${CACHE_PREFIX}slug:${slug}`, category, CACHE_TTL);
  }
  return category;
};

export const getCategoryTree = async (
  opts: CategoryTreeQuery = { depth_max: 5, status: 'active', include_product_count: true },
): Promise<CategoryNode[]> => {
  // Cache key now includes include_product_count -- previously a call with
  // counts on could be served a cached response built with counts off (or
  // vice versa), since the flag wasn't part of the key.
  const cacheKey =
    `${CACHE_PREFIX}tree:${opts.root_id ?? 'root'}:${opts.depth_max}:` +
    `${opts.status}:${opts.include_product_count ? 'counts' : 'nocounts'}`;
  const cached = await redisService.cacheGet<CategoryNode[]>(cacheKey);
  if (cached) return cached;

  const conditions: string[] = ['status = $1'];
  const params: unknown[] = [opts.status];

  if (opts.root_id) {
    params.push(opts.root_id);
    conditions.push(`path <@ (SELECT path FROM categories WHERE id = $${params.length})`);
  }

  // depth_max was previously accepted in CategoryTreeQuery but never
  // applied to the query -- every call fetched the full subtree
  // regardless of what the caller asked for.
  if (opts.depth_max !== undefined) {
    params.push(opts.depth_max);
    conditions.push(`depth <= $${params.length}`);
  }

  const result = await pool.query<Category>(
    `SELECT * FROM categories WHERE ${conditions.join(' AND ')} ORDER BY depth ASC, sort_order ASC`,
    params,
  );

  const map = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];

  for (const cat of result.rows) {
    map.set(cat.id, { ...cat, children: [], full_path: cat.name });
  }
  for (const cat of result.rows) {
    const node = map.get(cat.id)!;
    if (cat.parent_id && map.has(cat.parent_id)) {
      const parent = map.get(cat.parent_id)!;
      parent.children.push(node);
      node.full_path = `${parent.full_path} / ${cat.name}`;
    } else {
      roots.push(node);
    }
  }

  if (opts.include_product_count) {
    await attachProductCounts(roots);
  }

  await redisService.cacheSet(cacheKey, roots, CACHE_TTL);
  return roots;
};

/**
 * One query for all leaf-level counts, then a single bottom-up rollup.
 */
const attachProductCounts = async (roots: CategoryNode[]): Promise<void> => {
  const allNodes: CategoryNode[] = [];
  const walk = (n: CategoryNode) => {
    allNodes.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);

  if (!allNodes.length) return;

  const ids = allNodes.map((n) => n.id);
  const { rows } = await pool.query<{ category_id: string; count: string }>(
    `SELECT category_id, COUNT(*)::text AS count
     FROM products
     WHERE category_id = ANY($1::uuid[]) AND status = 'published' AND is_active = true
     GROUP BY category_id`,
    [ids],
  );

  const directCount = new Map<string, number>();
  for (const r of rows) directCount.set(r.category_id, Number(r.count));

  const rollup = (n: CategoryNode): number => {
    const direct = directCount.get(n.id) ?? 0;
    const childTotal = n.children.reduce((acc, c) => acc + rollup(c), 0);
    n.product_count = direct + childTotal;
    return n.product_count;
  };
  roots.forEach(rollup);
};

export const getCategories = async (
  query: CategoryQuery,
): Promise<{ categories: Category[]; total: number; page: number; limit: number }> => {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (query.parent_id) {
    conditions.push(`parent_id = $${i++}`);
    params.push(query.parent_id);
  } else if (query.parent_id_is_null) {
    conditions.push(`parent_id IS NULL`);
  }

  if (query.type) {
    conditions.push(`type = $${i++}`);
    params.push(query.type);
  }
  if (query.status) {
    conditions.push(`status = $${i++}`);
    params.push(query.status);
  }
  if (query.is_featured !== undefined) {
    conditions.push(`is_featured = $${i++}`);
    params.push(query.is_featured);
  }
  if (query.is_leaf !== undefined) {
    conditions.push(`is_leaf = $${i++}`);
    params.push(query.is_leaf);
  }
  if (query.search) {
    conditions.push(`(name ILIKE $${i} OR description ILIKE $${i})`);
    params.push(`%${query.search}%`);
    i++;
  }

  if (query.include_descendants && query.parent_id) {
    conditions.push(
      `path <@ (SELECT path FROM categories WHERE id = $${i++})`,
    );
    params.push(query.parent_id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sort = ensureSortColumn(query.sort ?? 'sort_order');
  const order = ensureDirection(query.order ?? 'asc');

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM categories ${where}`,
    params,
  );
  const total = Number(countRows[0].count);

  const listParams = [...params, limit, offset];
  const { rows } = await pool.query<Category>(
    `SELECT * FROM categories
     ${where}
     ORDER BY ${sort} ${order}
     LIMIT $${i} OFFSET $${i + 1}`,
    listParams,
  );

  return { categories: rows, total, page, limit };
};

// ============================================
// Delete (single + bulk)
// ============================================

/**
 * Shared delete logic, parameterized on the caller's own client/transaction
 * so a single delete and a batch delete can both run atomically. Previously
 * bulkDelete looped calling the exported deleteCategory(), which opened and
 * committed its own separate connection per call -- the outer BEGIN/COMMIT
 * wrapped nothing, so a failure partway through a batch left earlier
 * deletes permanently committed instead of rolling back.
 */
const deleteCategoryTx = async (
  id: string,
  force: boolean,
  client: PoolClient,
): Promise<void> => {
  const category = await findCategoryById(id, client);
  if (!category) throw new AppError(404, 'Category not found.');

  if (!force) {
    if (category.child_count > 0) {
      throw new AppError(400, 'Cannot delete category with children.');
    }
    if (category.product_count > 0) {
      throw new AppError(400, 'Cannot delete category with products.');
    }
  } else {
    // Cascade-delete descendants
    await client.query(
      `DELETE FROM categories WHERE path <@ $1::ltree AND id <> $2`,
      [category.path, id],
    );
  }

  await client.query(`DELETE FROM categories WHERE id = $1`, [id]);

  if (category.parent_id) {
    await client.query(
      `UPDATE categories
       SET child_count = GREATEST(child_count - 1, 0),
           is_leaf = (child_count - 1) <= 0,
           updated_at = now()
       WHERE id = $1`,
      [category.parent_id],
    );
  }
};

export const deleteCategory = async (id: string, force = false): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await deleteCategoryTx(id, force, client);
    await client.query('COMMIT');
    await invalidateCategoryCache();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const bulkUpdateStatus = async (
  body: BulkCategoryStatusBody,
): Promise<void> => {
  await pool.query(
    `UPDATE categories
     SET status = $1, updated_at = now()
     WHERE id = ANY($2::uuid[])`,
    [body.status, body.ids],
  );
  await invalidateCategoryCache();
};

export const bulkDelete = async (body: BulkCategoryDeleteBody): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of body.ids) {
      await deleteCategoryTx(id, body.force, client);
    }
    await client.query('COMMIT');
    // Previously missing entirely -- a successful bulk delete never
    // invalidated the cache, so deleted categories could keep serving
    // from Redis until their TTL expired.
    await invalidateCategoryCache();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ============================================
// Attribute lookup — used by seller Add Product form
// ============================================

export interface CategoryAttributeDTO {
  id: string;
  name: string;
  slug: string;
  type: string;
  description: string | null;
  is_required: boolean;
  is_filterable: boolean;
  is_variant: boolean;
  sort_order: number;
  validation: {
    min: number | null;
    max: number | null;
    regex: string | null;
    unit: string | null;
  };
  options: Array<{ id: string; value: string; slug: string }>;
}

export interface CategoryWithAttributes {
  category: {
    id: string;
    name: string;
    slug: string;
    is_leaf: boolean;
    parent_id: string | null;
    path: string;
  };
  attributes: CategoryAttributeDTO[];
}

const validationFor = (slug: string): CategoryAttributeDTO['validation'] => {
  switch (slug) {
    case 'ram_gb':           return { min: 1,    max: 256,   regex: null, unit: 'GB' };
    case 'storage_gb':       return { min: 8,    max: 8192,  regex: null, unit: 'GB' };
    case 'battery_mah':      return { min: 100,  max: 20000, regex: null, unit: 'mAh' };
    case 'battery_life_hrs': return { min: 1,    max: 200,   regex: null, unit: 'hrs' };
    case 'screen_size_in':   return { min: 1,    max: 100,   regex: null, unit: 'in' };
    case 'weight_kg':        return { min: 0.01, max: 1000,  regex: null, unit: 'kg' };
    case 'refresh_rate_hz':  return { min: 30,   max: 500,   regex: null, unit: 'Hz' };
    case 'camera_mp':        return { min: 1,    max: 500,   regex: null, unit: 'MP' };
    case 'spf':              return { min: 1,    max: 100,   regex: null, unit: null };
    case 'volume_ml':        return { min: 1,    max: 10000, regex: null, unit: 'ml' };
    default:                 return { min: null, max: null,  regex: null, unit: null };
  }
};

/**
 * Fetch the attributes (and their options) linked to a category.
 * Ordered by category_attributes.sort_order so the UI renders fields in the
 * intended order.
 *
 * Cached for 1 hour under `categories:attrs:{categoryId}`.
 */
export const getCategoryAttributes = async (
  categoryId: string,
): Promise<CategoryWithAttributes> => {
  const cacheKey = `${CACHE_PREFIX}attrs:${categoryId}`;

  const cached = await redisService.cacheGet<CategoryWithAttributes>(cacheKey);
  if (cached) return cached;

  // 1. Fetch the category
  const catResult = await pool.query<Category>(
    `SELECT * FROM categories WHERE id = $1 AND status = 'active'`,
    [categoryId],
  );

  if (catResult.rows.length === 0) {
    throw new AppError(404, 'Category not found.');
  }

  const cat = catResult.rows[0];

  // 2. Fetch linked attributes with options aggregated in one query
  const result = await pool.query(
    `SELECT
       ad.id,
       ad.name,
       ad.slug,
       ad.type,
       ad.description,
       ad.is_filterable,
       ad.is_variant,
       ca.is_required,
       ca.sort_order,
       COALESCE(
         json_agg(
           json_build_object('id', ao.id, 'value', ao.value, 'slug', ao.slug)
           ORDER BY ao.sort_order, ao.value
         ) FILTER (WHERE ao.id IS NOT NULL),
         '[]'::json
       ) AS options
     FROM category_attributes ca
     JOIN attribute_definitions ad ON ad.id = ca.attribute_id
     LEFT JOIN attribute_options ao ON ao.attribute_id = ad.id
     WHERE ca.category_id = $1
     GROUP BY
       ad.id, ad.name, ad.slug, ad.type, ad.description,
       ad.is_filterable, ad.is_variant,
       ca.is_required, ca.sort_order
     ORDER BY ca.sort_order ASC, ad.name ASC`,
    [categoryId],
  );

  const attributes: CategoryAttributeDTO[] = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    description: row.description,
    is_required: row.is_required,
    is_filterable: row.is_filterable,
    is_variant: row.is_variant,
    sort_order: row.sort_order,
    validation: validationFor(row.slug),
    options: row.options,
  }));

  const payload: CategoryWithAttributes = {
    category: {
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      is_leaf: cat.is_leaf,
      parent_id: cat.parent_id,
      path: cat.path,
    },
    attributes,
  };

  await redisService.cacheSet(cacheKey, payload, CACHE_TTL);
  return payload;
};