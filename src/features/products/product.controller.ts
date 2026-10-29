// src/features/product/product.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import { pool } from '../../config/db';

import {
  createProduct,
  getProductById,
  getProductBySlug,
  getProducts,
  updateProduct,
  adminUpdateProduct,
  deleteProduct,
  moderateProduct,
  createProductReview,
  getProductReviews,
  getProductMetrics,
  updateProductRating,
} from './product.service';

import {
  getPendingProductsForModeration,
  getProductReviewDetails,
} from '../moderator/moderator.service';

import { getSellerByUserId, checkSellerStatus } from '../seller/seller.service';

import {
  ProductStatus,
  ReviewStatus,
  type CreateProductInput,
  type UpdateProductInput,
  type GetProductsQuery,
} from './product.types';

import {
  ModerationTarget,
  ModerationPriority,
} from '../moderator/moderator.types';
import { createModerationItem } from '../moderator/moderator.service';

// ============================================
// HELPERS
// ============================================

const extractString = (param: string | string[] | undefined): string => {
  if (!param) throw new AppError(400, 'Parameter is required');
  return Array.isArray(param) ? param[0] : param;
};

const isValidUUID = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

const requireAuth = (req: Request): NonNullable<Request['user']> => {
  if (!req.user) throw new AppError(401, 'Authentication required.');
  return req.user;
};

const requireSeller = (req: Request): NonNullable<Request['user']> => {
  const user = requireAuth(req);
  if (user.role !== 'seller') {
    throw new AppError(403, 'Only sellers can perform this action.');
  }
  return user;
};

const requireAdmin = (req: Request): NonNullable<Request['user']> => {
  const user = requireAuth(req);
  if (user.role !== 'admin' && user.role !== 'super_admin') {
    throw new AppError(403, 'Admin access required.');
  }
  return user;
};

const requireModerator = (req: Request): NonNullable<Request['user']> => {
  const user = requireAuth(req);
  if (
    user.role !== 'moderator' &&
    user.role !== 'admin' &&
    user.role !== 'super_admin'
  ) {
    throw new AppError(403, 'Moderator access required.');
  }
  return user;
};

const requireActiveSellerForProducts = async (userId: string) => {
  const seller = await getSellerByUserId(userId);
  if (!seller) throw new AppError(404, 'Seller profile not found.');

  const status = await checkSellerStatus(seller.id);
  if (!status.is_active) {
    throw new AppError(
      403,
      status.block_reason || 'Your seller account is not active.'
    );
  }

  return seller;
};

const parseModerationBody = (body: {
  approved?: unknown;
  rejection_reason?: unknown;
  notes?: unknown;
}): {
  approved: boolean;
  rejection_reason?: string;
  notes?: string;
} => {
  if (typeof body.approved !== 'boolean') {
    throw new AppError(400, 'approval status (boolean) is required.');
  }

  const rejection_reason =
    typeof body.rejection_reason === 'string' && body.rejection_reason.trim()
      ? body.rejection_reason.trim()
      : undefined;

  if (body.approved === false && !rejection_reason) {
    throw new AppError(400, 'rejection_reason is required when rejecting.');
  }
  if (body.approved === true && rejection_reason) {
    throw new AppError(400, 'rejection_reason is not allowed when approving.');
  }

  const notes =
    typeof body.notes === 'string' && body.notes.trim()
      ? body.notes.trim()
      : undefined;

  return { approved: body.approved, rejection_reason, notes };
};

// ============================================
// PRODUCT CRUD (seller)
// ============================================

export const createProductHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireSeller(req);
    const storeId = extractString(req.params.storeId);
    if (!isValidUUID(storeId)) {
      throw new AppError(400, 'Invalid store ID format.');
    }

    const seller = await requireActiveSellerForProducts(user.id);
    const input = req.body as CreateProductInput;

    const product = await createProduct(seller.id, storeId, input, user.id);

    res.status(201).json({
      success: true,
      message:
        product.status === ProductStatus.PENDING
          ? 'Product created and submitted for approval.'
          : 'Product created successfully.',
      data: product,
    });
  }
);

export const getProductHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const product = await getProductById(productId);
    if (!product) throw new AppError(404, 'Product not found.');

    res.status(200).json({ success: true, data: product });
  }
);

export const getProductBySlugHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const slug = extractString(req.params.slug);
    const storeId = req.query.store_id as string | undefined;

    const product = await getProductBySlug(slug, storeId);
    if (!product) throw new AppError(404, 'Product not found.');

    res.status(200).json({ success: true, data: product });
  }
);

export const getProductsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query as unknown as GetProductsQuery;

    const sellerId =
      req.user?.role === 'seller'
        ? (await getSellerByUserId(req.user.id))?.id
        : undefined;

    const result = await getProducts(query, sellerId);

    res.status(200).json({
      success: true,
      data: result.products,
      filters: result.filters,
      pagination: result.pagination,
    });
  }
);

export const getMyProductsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireSeller(req);
    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, 'Seller profile not found.');

    const query = req.query as unknown as GetProductsQuery;
    const result = await getProducts({ ...query }, seller.id);

    res.status(200).json({
      success: true,
      data: result.products,
      filters: result.filters,
      pagination: result.pagination,
    });
  }
);

export const getStoreProductsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const storeId = extractString(req.params.storeId);
    if (!isValidUUID(storeId)) {
      throw new AppError(400, 'Invalid store ID format.');
    }

    const query = req.query as unknown as GetProductsQuery;
    const result = await getProducts({ ...query, store_id: storeId });

    res.status(200).json({
      success: true,
      data: result.products,
      filters: result.filters,
      pagination: result.pagination,
    });
  }
);

export const updateProductHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireSeller(req);
    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, 'Seller profile not found.');

    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const input = req.body as UpdateProductInput;
    const product = await updateProduct(productId, seller.id, input);

    res.status(200).json({
      success: true,
      message: 'Product updated successfully.',
      data: product,
    });
  }
);

export const deleteProductHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireSeller(req);
    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, 'Seller profile not found.');

    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    await deleteProduct(productId, seller.id);

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully.',
    });
  }
);

// ============================================
// PRODUCT STATUS & SUBMISSION
// ============================================

export const getProductStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAuth(req);
    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const product = await getProductById(productId, true);
    if (!product) throw new AppError(404, 'Product not found.');

    if (user.role === 'seller') {
      const seller = await getSellerByUserId(user.id);
      if (!seller || product.seller_id !== seller.id) {
        throw new AppError(403, 'You do not have access to this product.');
      }
    }

    res.status(200).json({
      success: true,
      data: {
        id: product.id,
        status: product.status,
        is_active: product.is_active,
        is_approved: product.is_approved,
        can_edit:
          product.status !== ProductStatus.SUSPENDED &&
          product.status !== ProductStatus.DISCONTINUED,
        can_publish:
          product.status === ProductStatus.DRAFT ||
          product.status === ProductStatus.REJECTED,
        can_delete: product.status !== ProductStatus.ACTIVE,
        can_update_stock: product.status !== ProductStatus.DISCONTINUED,
        block_reason: product.rejection_reason,
        actions_required:
          product.status === ProductStatus.REJECTED
            ? ['review_rejection_reason', 'resubmit']
            : [],
      },
    });
  }
);

export const submitProductForApproval = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireSeller(req);
    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, 'Seller profile not found.');

    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const product = await getProductById(productId, true);
    if (!product) throw new AppError(404, 'Product not found.');
    if (product.seller_id !== seller.id) {
      throw new AppError(
        403,
        'You do not have permission to submit this product.'
      );
    }
    if (
      product.status !== ProductStatus.DRAFT &&
      product.status !== ProductStatus.REJECTED
    ) {
      throw new AppError(
        409,
        `Product is already ${product.status}. Cannot submit for approval.`
      );
    }

    const updatedProduct = await updateProduct(productId, seller.id, {
      status: ProductStatus.PENDING,
    });

    await createModerationItem(
      ModerationTarget.PRODUCT,
      productId,
      user.id,
      ModerationPriority.MEDIUM,
      {
        product_name: product.name,
        product_type: product.type,
        store_id: product.store_id,
        seller_id: seller.id,
      }
    );

    res.status(200).json({
      success: true,
      message: 'Product submitted for approval successfully.',
      data: updatedProduct,
    });
  }
);

// ============================================
// PRODUCT REVIEWS
// ============================================

export const createProductReviewHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAuth(req);
    const review = await createProductReview(user.id, req.body);

    res.status(201).json({
      success: true,
      message: 'Review submitted successfully and pending moderation.',
      data: review,
    });
  }
);

export const getProductReviewsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const onlyApproved = req.query.only_approved !== 'false';

    const result = await getProductReviews(productId, page, limit, onlyApproved);

    res.status(200).json({
      success: true,
      data: result.reviews,
      summary: result.summary,
      pagination: result.pagination,
    });
  }
);

// ============================================
// PRODUCT METRICS
// ============================================

export const getProductMetricsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireSeller(req);
    const seller = await getSellerByUserId(user.id);
    if (!seller) throw new AppError(404, 'Seller profile not found.');

    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const product = await getProductById(productId, true);
    if (!product) throw new AppError(404, 'Product not found.');
    if (product.seller_id !== seller.id) {
      throw new AppError(
        403,
        "You do not have access to this product's metrics."
      );
    }

    const period =
      (req.query.period as 'today' | 'week' | 'month' | 'year' | 'all') ||
      'month';
    const metrics = await getProductMetrics(productId, period);

    res.status(200).json({ success: true, data: metrics });
  }
);

// ============================================
// ADMIN
// ============================================

export const getAllProductsAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);
    const query = req.query as unknown as GetProductsQuery;
    const result = await getProducts(query);

    res.status(200).json({
      success: true,
      data: result.products,
      filters: result.filters,
      pagination: result.pagination,
    });
  }
);

export const getProductAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);
    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const product = await getProductById(productId, true);
    if (!product) throw new AppError(404, 'Product not found.');

    res.status(200).json({ success: true, data: product });
  }
);

export const approveProductHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAdmin(req);
    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const { approved, rejection_reason, notes } = parseModerationBody(req.body);

    const product = await moderateProduct(
      productId,
      user.id,
      approved,
      rejection_reason,
      notes
    );

    res.status(200).json({
      success: true,
      message: approved
        ? 'Product approved successfully.'
        : 'Product rejected.',
      data: product,
    });
  }
);

export const bulkProductOperation = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireAdmin(req);
    const { product_ids, action, status } = req.body;

    if (!Array.isArray(product_ids) || product_ids.length === 0) {
      throw new AppError(
        400,
        'product_ids is required and must be a non-empty array.'
      );
    }

    const results = {
      processed: 0,
      failed: 0,
      errors: [] as { id: string; error: string }[],
    };

    for (const productId of product_ids) {
      try {
        const product = await getProductById(productId, true);
        if (!product) {
          results.failed++;
          results.errors.push({ id: productId, error: 'Product not found' });
          continue;
        }

        switch (action) {
          case 'activate':
            await moderateProduct(productId, user.id, true, undefined, 'Bulk activate');
            results.processed++;
            break;

          case 'deactivate':
            await adminUpdateProduct(productId, { status: ProductStatus.DRAFT });
            results.processed++;
            break;

          case 'feature':
            await adminUpdateProduct(productId, { is_featured: true });
            results.processed++;
            break;

          case 'unfeature':
            await adminUpdateProduct(productId, { is_featured: false });
            results.processed++;
            break;

          case 'delete':
            await pool.query(
              `UPDATE products SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
              [productId]
            );
            results.processed++;
            break;

          case 'update_status':
            if (!status) throw new AppError(400, 'Status is required.');
            await adminUpdateProduct(productId, { status });
            results.processed++;
            break;

          default:
            throw new AppError(400, `Unknown action: ${action}`);
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          id: productId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    res.status(200).json({
      success: true,
      message: `Processed ${results.processed} products. ${results.failed} failed.`,
      data: results,
    });
  }
);

export const getProductStatsAdmin = asyncHandler(
  async (req: Request, res: Response) => {
    requireAdmin(req);

    const result = await pool.query(`
      SELECT
        COUNT(*) AS total_products,
        COUNT(*) FILTER (WHERE status = 'active' AND is_active = true) AS active,
        COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
        COUNT(*) FILTER (WHERE status = 'draft')    AS draft,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
        COUNT(*) FILTER (WHERE status = 'suspended') AS suspended,
        COUNT(*) FILTER (WHERE status = 'discontinued') AS discontinued,
        COUNT(*) FILTER (WHERE stock_quantity > 0 AND stock_status = 'in_stock') AS in_stock,
        COUNT(*) FILTER (WHERE stock_quantity = 0 OR stock_status = 'out_of_stock') AS out_of_stock,
        SUM(stock_quantity) AS total_stock,
        COALESCE(AVG(price), 0) AS avg_price,
        COALESCE(SUM(price), 0) AS total_value,
        COALESCE(SUM(view_count), 0) AS total_views
      FROM products WHERE deleted_at IS NULL
    `);

    res.status(200).json({ success: true, data: result.rows[0] });
  }
);

// ============================================
// MODERATOR
// ============================================

export const getPendingProductsModerator = asyncHandler(
  async (req: Request, res: Response) => {
    requireModerator(req);

    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const search = req.query.search as string | undefined;

    const result = await getPendingProductsForModeration(page, limit, search);

    res.status(200).json({
      success: true,
      data: result.items,
      pagination: {
        page,
        limit,
        total: result.total,
        pages: result.pages,
      },
    });
  }
);

export const getProductForReviewModerator = asyncHandler(
  async (req: Request, res: Response) => {
    requireModerator(req);

    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const details = await getProductReviewDetails(productId);

    res.status(200).json({ success: true, data: details });
  }
);

export const reviewProductModerator = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireModerator(req);

    const productId = extractString(req.params.productId);
    if (!isValidUUID(productId)) {
      throw new AppError(400, 'Invalid product ID format.');
    }

    const { approved, rejection_reason, notes } = parseModerationBody(req.body);

    const product = await moderateProduct(
      productId,
      user.id,
      approved,
      rejection_reason,
      notes
    );

    res.status(200).json({
      success: true,
      message: approved
        ? 'Product approved successfully.'
        : 'Product rejected.',
      data: product,
    });
  }
);

export const moderateProductReviewHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireModerator(req);

    const reviewId = extractString(req.params.reviewId);
    if (!isValidUUID(reviewId)) {
      throw new AppError(400, 'Invalid review ID format.');
    }

    const { approved, reason } = req.body;
    if (typeof approved !== 'boolean') {
      throw new AppError(400, 'approval status (boolean) is required.');
    }
    if (approved === false && (!reason || !String(reason).trim())) {
      throw new AppError(400, 'reason is required when rejecting a review.');
    }

    const nextStatus = approved ? ReviewStatus.APPROVED : ReviewStatus.REJECTED;

    const result = await pool.query(
      `UPDATE product_reviews
       SET status = $1,
           is_approved = $2,
           moderated_by = $3,
           moderated_at = NOW(),
           moderation_reason = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [nextStatus, approved, user.id, reason ?? null, reviewId]
    );

    if (result.rows.length === 0) throw new AppError(404, 'Review not found.');

    await updateProductRating(result.rows[0].product_id);

    await pool.query(
      `INSERT INTO moderation_history (
         moderator_id, action, target_type, target_id, notes, created_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        user.id,
        approved ? 'review_approved' : 'review_rejected',
        'review',
        reviewId,
        reason ?? null,
      ]
    );

    res.status(200).json({
      success: true,
      message: approved
        ? 'Review approved successfully.'
        : 'Review rejected.',
      data: result.rows[0],
    });
  }
);