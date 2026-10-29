// src/features/catalog/category.routes.ts
import { Router } from 'express';
import { protect, requireRole } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';

import {
  categoryIdParamSchema,
  categoryIdParamSchemaAlt,
  categorySlugParamSchema,
  categoryQuerySchema,
  categoryTreeQuerySchema,
  createCategorySchema,
  updateCategorySchema,
  moveCategorySchema,
  reorderCategoriesSchema,
  bulkCategoryStatusSchema,
  bulkCategoryDeleteSchema,
} from './category.validator';

import {
  // Admin — CRUD
  createCategoryHandler,
  updateCategoryHandler,
  deleteCategoryHandler,
  // Admin — tree ops
  moveCategoryHandler,
  reorderCategoriesHandler,
  // Admin — bulk
  bulkCategoryStatusHandler,
  bulkCategoryDeleteHandler,
  // Public — read
  getCategoryTreeHandler,
  getCategoryByIdHandler,
  getCategoryBySlugHandler,
  getCategoryAttributesHandler,
  getCategoriesHandler,
} from './category.controller';

const router = Router();

const admin = [protect, requireRole('admin', 'super_admin')];

// ============================================
// Public — Static paths (must come first)
// ============================================

/** GET /api/v1/categories/tree */
router.get(
  '/tree',
  validate(categoryTreeQuerySchema),
  getCategoryTreeHandler,
);

// ============================================
// Public — Nested under literal
// ============================================

/** GET /api/v1/categories/slug/:slug */
router.get(
  '/slug/:slug',
  validate(categorySlugParamSchema),
  getCategoryBySlugHandler,
);

// ============================================
// Admin — Static paths
// ============================================

/** POST /api/v1/categories/reorder */
router.post(
  '/reorder',
  ...admin,
  validate(reorderCategoriesSchema),
  reorderCategoriesHandler,
);

/** PATCH /api/v1/categories/bulk/status */
router.patch(
  '/bulk/status',
  ...admin,
  validate(bulkCategoryStatusSchema),
  bulkCategoryStatusHandler,
);

/** POST /api/v1/categories/bulk/delete */
router.post(
  '/bulk/delete',
  ...admin,
  validate(bulkCategoryDeleteSchema),
  bulkCategoryDeleteHandler,
);

// ============================================
// Root collection
// ============================================

/** GET /api/v1/categories */
router.get(
  '/',
  validate(categoryQuerySchema),
  getCategoriesHandler,
);

/** POST /api/v1/categories */
router.post(
  '/',
  ...admin,
  validate(createCategorySchema),
  createCategoryHandler,
);

// ============================================
// Nested under dynamic :categoryId
// (specific sub-paths — MUST come BEFORE /:id)
// ============================================

/**
 * GET /api/v1/categories/:categoryId/attributes
 *
 * Returns the attribute definitions (with select options) linked to a
 * category. Used by the seller Add Product form to render dynamic fields.
 *
 * Public — any authenticated or anonymous caller can fetch these.
 *
 * NOTE: uses :categoryId (not :id) so the handler's `req.params.categoryId`
 * reads the correct segment. The alt validator (categoryIdParamSchemaAlt)
 * validates params.categoryId accordingly.
 */
router.get(
  '/:categoryId/attributes',
  validate(categoryIdParamSchemaAlt),
  getCategoryAttributesHandler,
);

/** POST /api/v1/categories/:id/move */
router.post(
  '/:id/move',
  ...admin,
  validate(moveCategorySchema),
  moveCategoryHandler,
);

// ============================================
// Dynamic :id (must come last)
// ============================================

/** GET /api/v1/categories/:id */
router.get(
  '/:id',
  validate(categoryIdParamSchema),
  getCategoryByIdHandler,
);

/** PATCH /api/v1/categories/:id */
router.patch(
  '/:id',
  ...admin,
  validate(updateCategorySchema),
  updateCategoryHandler,
);

/** DELETE /api/v1/categories/:id?force=true */
router.delete(
  '/:id',
  ...admin,
  validate(categoryIdParamSchema),
  deleteCategoryHandler,
);

export default router;