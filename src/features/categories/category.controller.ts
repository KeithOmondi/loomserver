// src/features/catalog/category.controller.ts
import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import {
  createCategory,
  updateCategory,
  deleteCategory,
  moveCategory,
  reorderCategories,
  bulkUpdateStatus,
  bulkDelete,
  getCategoryById,
  getCategoryBySlug,
  getCategoryTree,
  getCategories,
  getCategoryAttributes,
} from './category.service';
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
import type { Category } from './category.types';

// ============================================
// Helpers
// ============================================

const requireAdmin = (req: Request): string => {
  if (!req.user) throw new AppError(401, 'Authentication required.');
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    throw new AppError(403, 'Admin access required.');
  }
  return req.user.id;
};

const isAdmin = (req: Request): boolean =>
  req.user?.role === 'admin' || req.user?.role === 'super_admin';

const hideIfInactive = (req: Request, category: Category | null): Category => {
  if (!category) throw new AppError(404, 'Category not found.');
  if (category.status !== 'active' && !isAdmin(req)) {
    throw new AppError(404, 'Category not found.');
  }
  return category;
};

const isValidUUID = (id: string): boolean => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return re.test(id);
};

// ============================================
// Admin — Create / Update / Delete
// ============================================

/**
 * Create a new category (admin only)
 * POST /api/v1/categories
 */
export const createCategoryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = requireAdmin(req);
    const body = req.body as CreateCategoryBody;

    const category = await createCategory(body, userId);

    res.status(201).json({
      success: true,
      message: 'Category created successfully.',
      data: category,
    });
  },
);

/**
 * Update a category (admin only)
 * PATCH /api/v1/categories/:id
 */
export const updateCategoryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = req.body as UpdateCategoryBody;

    const category = await updateCategory(id, body);

    res.status(200).json({
      success: true,
      message: 'Category updated successfully.',
      data: category,
    });
  },
);

/**
 * Delete a category (admin only)
 * DELETE /api/v1/categories/:id
 */
export const deleteCategoryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const force = req.query.force === 'true';

    await deleteCategory(id, force);

    res.status(200).json({
      success: true,
      message: 'Category deleted successfully.',
    });
  },
);

// ============================================
// Admin — Tree ops
// ============================================

/**
 * Move a category under a new parent (admin only)
 * POST /api/v1/categories/:id/move
 */
export const moveCategoryHandler = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = req.body as MoveCategoryBody;

    const category = await moveCategory(id, body);

    res.status(200).json({
      success: true,
      message: 'Category moved successfully.',
      data: category,
    });
  },
);

/**
 * Reorder sibling categories (admin only)
 * POST /api/v1/categories/reorder
 */
export const reorderCategoriesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);
    const body = req.body as ReorderCategoriesBody;

    await reorderCategories(body);

    res.status(200).json({
      success: true,
      message: 'Categories reordered successfully.',
    });
  },
);

// ============================================
// Admin — Bulk ops
// ============================================

/**
 * Bulk change status (admin only)
 * PATCH /api/v1/categories/bulk/status
 */
export const bulkCategoryStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);
    const body = req.body as BulkCategoryStatusBody;

    await bulkUpdateStatus(body);

    res.status(200).json({
      success: true,
      message: `Updated ${body.ids.length} categor${body.ids.length === 1 ? 'y' : 'ies'}.`,
    });
  },
);

/**
 * Bulk delete (admin only)
 * POST /api/v1/categories/bulk/delete
 */
export const bulkCategoryDeleteHandler = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);
    const body = req.body as BulkCategoryDeleteBody;

    await bulkDelete(body);

    res.status(200).json({
      success: true,
      message: `Deleted ${body.ids.length} categor${body.ids.length === 1 ? 'y' : 'ies'}.`,
    });
  },
);

// ============================================
// Public — Tree
// ============================================

/**
 * Get category tree (public)
 * GET /api/v1/categories/tree
 *
 * Query params:
 *   - root_id?               (uuid)
 *   - depth_max?             (0..10, default 5)
 *   - include_product_count? (true|false, default true)
 *
 * Public callers always get status='active'.
 * Admin callers can override via `?status=...`.
 */
export const getCategoryTreeHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query as unknown as CategoryTreeQuery;

    const status = isAdmin(req) ? query.status : 'active';

    const tree = await getCategoryTree({
      ...query,
      status,
    });

    res.status(200).json({
      success: true,
      data: tree,
    });
  },
);

// ============================================
// Public — Read single
// ============================================

/**
 * Get category by ID (public)
 * GET /api/v1/categories/:id
 */
export const getCategoryByIdHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    const category = await getCategoryById(id);
    const safe = hideIfInactive(req, category);

    res.status(200).json({
      success: true,
      data: safe,
    });
  },
);

/**
 * Get category by slug (public)
 * GET /api/v1/categories/slug/:slug
 */
export const getCategoryBySlugHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };

    const category = await getCategoryBySlug(slug);
    const safe = hideIfInactive(req, category);

    res.status(200).json({
      success: true,
      data: safe,
    });
  },
);

/**
 * Get attributes linked to a category (public)
 * GET /api/v1/categories/:categoryId/attributes
 *
 * Returns the attribute definitions (with their select options) that a
 * seller needs to fill in when creating a product in this category.
 *
 * Cached server-side for 1 hour.
 */
export const getCategoryAttributesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const categoryId = Array.isArray(req.params.categoryId)
      ? req.params.categoryId[0]
      : req.params.categoryId;

    if (!categoryId) {
      throw new AppError(400, 'Category ID is required.');
    }

    if (!isValidUUID(categoryId)) {
      throw new AppError(400, 'Invalid category ID format. Expected UUID.');
    }

    const data = await getCategoryAttributes(categoryId);
    res.status(200).json({ success: true, data });
  },
);

// ============================================
// Public — List
// ============================================

/**
 * List categories (public)
 * GET /api/v1/categories
 *
 * Public callers always get status='active'.
 * Admin callers can filter by status via `?status=...`.
 */
export const getCategoriesHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query as unknown as CategoryQuery;

    const effectiveQuery: CategoryQuery = {
      ...query,
      status: isAdmin(req) ? query.status : 'active',
    };

    const { categories, total, page, limit } = await getCategories(effectiveQuery);

    res.status(200).json({
      success: true,
      data: categories,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  },
);