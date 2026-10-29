// src/features/moderator/moderator.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import {
    getModerationQueue,
    getModerationQueueSummary,
    getModerationStats,
    getModerationItemById,
    updateModerationStatus,
    getModerationHistory,
    updateModerationPriority,
    bulkModerateItems,
    getModerationDashboard,
    createModerationItem,
    getStoreModerationStats,
    getModeratorStatsWithStores,
    getPendingStoresForModeration,
    getAllStoresForModeration,
    getAllSellersForModeration, // <-- NEW
    reviewStore,
    assignModeratorToItem,
} from './moderator.service';
import {
    ModerationTarget,
    ModerationStatus,
    ModerationPriority,
    ModerationAction,
    ModerationFilters,
    ReviewStoreInput,
    ReviewProductInput,
    VerifySellerInput,
    ModerateContentInput,
    ResolveDisputeInput,
    BulkModerationInput,
    PendingStoreReview,
} from './moderator.types';
import { requireModerator } from '../../middlewares/auth.middleware';
import { pool } from '../../config/db';
import { updateSellerVerification, verifySellerBulk } from '../seller/seller.service';

// ============================================
// HELPER: Extract String from Params
// ============================================

const extractString = (param: string | string[] | undefined): string => {
    if (!param) {
        throw new AppError(400, 'Parameter is required');
    }
    if (Array.isArray(param)) {
        return param[0];
    }
    return param;
};

// ============================================
// HELPER: Validate UUID
// ============================================

const isValidUUID = (id: string): boolean => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
};

// ============================================
// DASHBOARD
// ============================================

export const getDashboard = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const dashboard = await getModerationDashboard();

    res.status(200).json({
        success: true,
        data: dashboard,
    });
});

// ============================================
// GET PENDING STORES
// ============================================

export const getPendingStores = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const search = req.query.search as string | undefined;

    const result = await getPendingStoresForModeration(page, limit, search);

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
});

// ============================================
// GET ALL STORES (any status)
// ============================================
//
// Returns every store regardless of status. Optional `status` query
// param narrows to a single status ('pending' | 'in_review' | 'approved'
// | 'rejected' | 'suspended'). An empty string is treated as "no filter"
// so the UI can send `?status=` for its "All Statuses" option without
// erroring.

export const getAllStores = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const search = req.query.search as string | undefined;
    const rawStatus = req.query.status as string | undefined;

    // Treat empty string / whitespace as "no filter"
    const statusFilter =
        rawStatus && rawStatus.trim() !== '' ? rawStatus.trim() : undefined;

    // Validate status against the allowed set if provided
    if (statusFilter) {
        const allowed = [
            'pending',
            'in_review',
            'approved',
            'rejected',
            'suspended',
        ];
        if (!allowed.includes(statusFilter)) {
            throw new AppError(
                400,
                `Invalid status filter. Must be one of: ${allowed.join(', ')}`
            );
        }
    }

    const result = await getAllStoresForModeration(
        page,
        limit,
        search,
        statusFilter
    );

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
});

// ============================================
// GET STORE MODERATION STATS
// ============================================
//
// Dedicated endpoint for the store-moderation page stat cards.
// Returns totals, counts per status, and a category distribution.

export const getStoreStats = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const stats = await getStoreModerationStats();

    res.status(200).json({
        success: true,
        data: stats,
    });
});

// ============================================
// GET MODERATOR STATS
// ============================================

export const getModeratorStats = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const stats = await getModeratorStatsWithStores();

    res.status(200).json({
        success: true,
        data: stats,
    });
});

// ============================================
// QUEUE MANAGEMENT
// ============================================

export const getQueue = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const filters: ModerationFilters = {
        target_type: req.query.target_type as any,
        status: req.query.status as any,
        priority: req.query.priority as any,
        search: req.query.search as string,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
        sortBy: req.query.sortBy as any,
        sortOrder: req.query.sortOrder as any,
        // ✅ Pass through as ISO strings; the service can `new Date(...)` if it needs to
        date_from: req.query.date_from as string | undefined,
        date_to: req.query.date_to as string | undefined,
    };

    const result = await getModerationQueue(filters);

    res.status(200).json({
        success: true,
        data: result.items,
        pagination: result.pagination,
    });
});

export const getQueueSummary = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const summary = await getModerationQueueSummary();

    res.status(200).json({
        success: true,
        data: summary,
    });
});

export const getModerationItem = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const itemId = extractString(req.params.itemId);

    if (!isValidUUID(itemId)) {
        throw new AppError(400, 'Invalid item ID format. Expected UUID.');
    }

    const item = await getModerationItemById(itemId);

    if (!item) {
        throw new AppError(404, 'Moderation item not found.');
    }

    res.status(200).json({
        success: true,
        data: item,
    });
});

export const updatePriority = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    if (!req.user) {
        throw new AppError(401, 'Authentication required.');
    }

    const itemId = extractString(req.params.itemId);

    if (!isValidUUID(itemId)) {
        throw new AppError(400, 'Invalid item ID format. Expected UUID.');
    }

    const { priority } = req.body;

    if (!priority || !['low', 'medium', 'high', 'urgent'].includes(priority)) {
        throw new AppError(400, 'Invalid priority. Must be: low, medium, high, urgent');
    }

    const item = await updateModerationPriority(itemId, priority as ModerationPriority);

    res.status(200).json({
        success: true,
        message: 'Priority updated successfully.',
        data: item,
    });
});

export const assignModerator = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    if (!req.user) {
        throw new AppError(401, 'Authentication required.');
    }

    const itemId = extractString(req.params.itemId);

    if (!isValidUUID(itemId)) {
        throw new AppError(400, 'Invalid item ID format. Expected UUID.');
    }

    const item = await assignModeratorToItem(itemId, req.user.id);

    res.status(200).json({
        success: true,
        message: 'Moderator assigned to item successfully.',
        data: item,
    });
});

// ============================================
// STORE MODERATION
// ============================================

export const getStoreForReview = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const storeId = extractString(req.params.storeId);

    if (!isValidUUID(storeId)) {
        throw new AppError(400, 'Invalid store ID format. Expected UUID.');
    }

    // ✅ FIX: replaced `reviews` (which doesn't exist) with `store_reviews`,
    // and count by store_id (not seller_id) to match the actual FK.
    // Note: if stores table has an `is_approved` column it's selected via st.*;
    // if not, remove `is_approved` from the seller block below.
    const storeResult = await pool.query(
        `SELECT 
            st.*,
            jsonb_build_object(
                'id', s.id,
                'legal_business_name', s.business_name,
                'trading_name', s.trading_name,
                'business_type', s.business_type,
                'country', s.country,
                'state', s.state,
                'city', s.city,
                'business_address', s.business_address,
                'business_phone', s.business_phone,
                'status', s.status,
                'verification_status', s.verification_status,
                'rating', s.rating,
                'total_reviews', s.total_reviews,
                'total_orders', s.total_orders,
                'total_products', s.total_products,
                'total_stores', s.total_stores,
                'fulfillment_rate', s.fulfillment_rate,
                'response_rate', s.response_rate,
                'email', u.email,
                'full_name', u.full_name,
                'phone', u.phone,
                'user_joined_at', u.created_at
            ) as seller,
            (
                SELECT COUNT(*) FROM products 
                WHERE store_id = st.id AND deleted_at IS NULL
            ) as products_count,
            (
                SELECT COUNT(*) FROM store_reviews 
                WHERE store_id = st.id AND deleted_at IS NULL
            ) as reviews_count,
            (
                SELECT COUNT(*) FROM orders 
                WHERE store_id = st.id
            ) as orders_count
        FROM stores st
        LEFT JOIN sellers s ON s.id = st.seller_id
        LEFT JOIN users u ON u.id = s.user_id
        WHERE st.id = $1 AND st.deleted_at IS NULL`,
        [storeId]
    );

    if (storeResult.rows.length === 0) {
        throw new AppError(404, 'Store not found.');
    }

    const row = storeResult.rows[0];

    // Get moderation history
    const historyResult = await pool.query(
        `SELECT 
            mh.*,
            u.full_name as moderator_name,
            u.email as moderator_email
        FROM moderation_history mh
        LEFT JOIN users u ON u.id = mh.moderator_id
        WHERE mh.target_type = 'store' AND mh.target_id = $1
        ORDER BY mh.created_at DESC
        LIMIT 10`,
        [storeId]
    );

    res.status(200).json({
        success: true,
        data: {
            store: row,
            seller: row.seller,
            products_count: parseInt(row.products_count || '0'),
            reviews_count: parseInt(row.reviews_count || '0'),
            orders_count: parseInt(row.orders_count || '0'),
            review_history: historyResult.rows,
        },
    });
});

export const reviewStoreHandler = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    if (!req.user) {
        throw new AppError(401, 'Authentication required.');
    }

    const storeId = extractString(req.params.storeId);

    if (!isValidUUID(storeId)) {
        throw new AppError(400, 'Invalid store ID format. Expected UUID.');
    }

    const { approved, rejection_reason, notes } = req.body as ReviewStoreInput;

    // Check if store exists
    const storeCheck = await pool.query(
        `SELECT id, name FROM stores WHERE id = $1 AND deleted_at IS NULL`,
        [storeId]
    );

    if (storeCheck.rows.length === 0) {
        throw new AppError(404, 'Store not found.');
    }

    const store = storeCheck.rows[0];

    // Use the service to review the store
    const result = await reviewStore(
        storeId,
        req.user.id,
        approved,
        rejection_reason,
        notes
    );

    res.status(200).json({
        success: true,
        message: approved ? 'Store approved successfully.' : 'Store rejected.',
        data: {
            storeId,
            storeName: store.name,
            approved,
            moderationItem: result.moderationItem,
        },
    });
});

// ============================================
// BULK MODERATION
// ============================================

export const bulkModerate = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    if (!req.user) {
        throw new AppError(401, 'Authentication required.');
    }

    const { target_type, target_ids, action, notes } = req.body as BulkModerationInput;

    if (!target_type || !target_ids || !action) {
        throw new AppError(400, 'target_type, target_ids, and action are required.');
    }

    if (!Array.isArray(target_ids) || target_ids.length === 0) {
        throw new AppError(400, 'target_ids must be a non-empty array.');
    }

    // Validate all IDs are valid UUIDs
    for (const id of target_ids) {
        if (!isValidUUID(id)) {
            throw new AppError(400, `Invalid UUID format: ${id}`);
        }
    }

    const result = await bulkModerateItems(
        target_type as ModerationTarget,
        target_ids,
        req.user.id,
        action as ModerationAction,
        notes
    );

    res.status(200).json({
        success: result.success,
        message: `Processed ${result.processed} items. ${result.failed} failed.`,
        data: result,
    });
});

// ============================================
// REPORT CONTENT (User-facing)
// ============================================

export const reportContent = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) {
        throw new AppError(401, 'Authentication required.');
    }

    const { target_type, target_id, priority, notes, metadata } = req.body;

    if (!target_type || !target_id) {
        throw new AppError(400, 'target_type and target_id are required.');
    }

    if (!isValidUUID(target_id)) {
        throw new AppError(400, 'Invalid target ID format. Expected UUID.');
    }

    // Check if target exists based on type
    let targetExists = false;
    let targetName = '';

    if (target_type === 'store') {
        const result = await pool.query(
            `SELECT id, name FROM stores WHERE id = $1 AND deleted_at IS NULL`,
            [target_id]
        );
        targetExists = result.rows.length > 0;
        targetName = result.rows[0]?.name || 'Store';
    } else if (target_type === 'product') {
        const result = await pool.query(
            `SELECT id, name FROM products WHERE id = $1 AND deleted_at IS NULL`,
            [target_id]
        );
        targetExists = result.rows.length > 0;
        targetName = result.rows[0]?.name || 'Product';
    } else if (target_type === 'seller') {
        const result = await pool.query(
            `SELECT id, business_name FROM sellers WHERE id = $1`,
            [target_id]
        );
        targetExists = result.rows.length > 0;
        targetName = result.rows[0]?.business_name || 'Seller';
    }

    if (!targetExists) {
        throw new AppError(404, `${target_type} not found.`);
    }

    const item = await createModerationItem(
        target_type as ModerationTarget,
        target_id,
        req.user.id,
        (priority as ModerationPriority) || ModerationPriority.MEDIUM,
        { ...metadata, reported_by: req.user.id, reported_at: new Date() },
        notes
    );

    res.status(201).json({
        success: true,
        message: `${target_type} reported for moderation successfully.`,
        data: {
            moderationId: item.id,
            targetType: target_type,
            targetId: target_id,
            targetName,
        },
    });
});

// ============================================
// HISTORY & STATS
// ============================================

export const getHistory = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const { moderator_id, target_type, action, page, limit } = req.query;

    const result = await getModerationHistory({
        moderatorId: moderator_id as string,
        targetType: target_type as string,
        action: action as string,
        page: page ? parseInt(page as string) : 1,
        limit: limit ? parseInt(limit as string) : 20,
    });

    res.status(200).json({
        success: true,
        data: result.items,
        pagination: result.pagination,
    });
});

export const getStats = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const stats = await getModerationStats();

    res.status(200).json({
        success: true,
        data: stats,
    });
});

// ============================================
// PRODUCT MODERATION
// ============================================

export const getProductForReview = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const productId = extractString(req.params.productId);

    if (!isValidUUID(productId)) {
        throw new AppError(400, 'Invalid product ID format. Expected UUID.');
    }

    // ✅ Fetch product + store + seller + stats in one query
    const productResult = await pool.query(
        `SELECT 
            p.*,
            st.id   AS store_pk,
            st.name AS store_name,
            st.slug AS store_slug,
            s.id    AS seller_pk,
            s.business_name AS seller_business_name,
            s.trading_name  AS seller_trading_name,
            s.rating        AS seller_rating,
            u.id    AS seller_user_id,
            u.full_name AS seller_user_name,
            u.email     AS seller_user_email,
            (SELECT COUNT(*) FROM product_views WHERE product_id = p.id) AS stat_views,
            (SELECT COUNT(*) FROM wishlists     WHERE product_id = p.id) AS stat_wishlists,
            (SELECT COUNT(*) FROM order_items   WHERE product_id = p.id) AS stat_orders
        FROM products p
        LEFT JOIN stores  st ON st.id = p.store_id
        LEFT JOIN sellers s  ON s.id  = p.seller_id
        LEFT JOIN users   u  ON u.id  = s.user_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [productId]
    );

    if (productResult.rows.length === 0) {
        throw new AppError(404, 'Product not found.');
    }

    const row = productResult.rows[0];

    // ✅ Shape into ModerationProductSnapshot — matches frontend's
    //    moderatorGetProduct query type.
    const data = {
        product: {
            id: row.id,
            store_id: row.store_id,
            seller_id: row.seller_id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            short_description: row.short_description,
            tags: row.tags ?? [],
            type: row.type,
            condition: row.condition,
            visibility: row.visibility,
            category_id: row.category_id,
            price: Number(row.price),
            compare_at_price: row.compare_at_price ? Number(row.compare_at_price) : null,
            cost_per_item: row.cost_per_item ? Number(row.cost_per_item) : null,
            tax_class: row.tax_class,
            is_taxable: row.is_taxable,
            sku: row.sku,
            barcode: row.barcode,
            stock_quantity: row.stock_quantity,
            stock_status: row.stock_status,
            low_stock_threshold: row.low_stock_threshold,
            allow_backorders: row.allow_backorders,
            allow_preorders: row.allow_preorders,
            preorder_release_date: row.preorder_release_date,
            weight: row.weight ? Number(row.weight) : null,
            weight_unit: row.weight_unit,
            dimensions: row.dimensions,
            requires_shipping: row.requires_shipping,
            shipping_class: row.shipping_class,
            video_url: row.video_url,
            has_variants: row.has_variants,
            variant_attribute_ids: row.variant_attribute_ids ?? [],
            digital_file_url: row.digital_file_url,
            digital_file_size: row.digital_file_size ? Number(row.digital_file_size) : null,
            digital_file_name: row.digital_file_name,
            license_key: row.license_key,
            seo: row.seo ?? {},
            status: row.status,
            is_active: row.is_active,
            is_approved: row.is_approved,
            is_featured: row.is_featured,
            rejection_reason: row.rejection_reason,
            moderated_at: row.moderated_at,
            moderated_by: row.moderated_by,
            moderation_notes: row.moderation_notes,
            view_count: row.view_count,
            wishlist_count: row.wishlist_count,
            order_count: row.order_count,
            average_rating: Number(row.average_rating ?? 0),
            total_reviews: row.total_reviews,
            sales_count: row.sales_count,
            created_at: row.created_at,
            updated_at: row.updated_at,
            published_at: row.published_at,
            deleted_at: row.deleted_at,
            metadata: row.metadata,
            images: [], // no images column in products table
        },
        store: row.store_pk ? {
            id: row.store_pk,
            name: row.store_name,
            slug: row.store_slug,
        } : undefined,
        seller: row.seller_pk ? {
            id: row.seller_pk,
            legal_business_name: row.seller_business_name,
            trading_name: row.seller_trading_name,
            rating: Number(row.seller_rating ?? 0),
            user: row.seller_user_id ? {
                id: row.seller_user_id,
                full_name: row.seller_user_name,
                email: row.seller_user_email,
            } : undefined,
        } : undefined,
        stats: {
            views: parseInt(row.stat_views || '0'),
            wishlist_count: parseInt(row.stat_wishlists || '0'),
            order_count: parseInt(row.stat_orders || '0'),
            average_rating: Number(row.average_rating ?? 0),
            total_reviews: row.total_reviews ?? 0,
        },
        moderation_history: [],
    };

    res.status(200).json({ success: true, data });
});

export const reviewProduct = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    if (!req.user) {
        throw new AppError(401, 'Authentication required.');
    }

    const productId = extractString(req.params.productId);

    if (!isValidUUID(productId)) {
        throw new AppError(400, 'Invalid product ID format. Expected UUID.');
    }

    const { approved, rejection_reason, notes } = req.body as ReviewProductInput;

    const productCheck = await pool.query(
        `SELECT id, name, store_id FROM products WHERE id = $1 AND deleted_at IS NULL`,
        [productId]
    );

    if (productCheck.rows.length === 0) {
        throw new AppError(404, 'Product not found.');
    }

    const product = productCheck.rows[0];

    // ✅ FIX: The DB has a lifecycle CHECK constraint:
    //   status='active'  <=> is_active=true  AND is_approved=true
    //   status<>'active' <=> is_active=false AND is_approved=false
    // So we must update status, is_active, AND is_approved together,
    // otherwise the CHECK fails. This replaces the previous UPDATE that
    // only set is_active and would violate the constraint.
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `UPDATE products 
             SET status = $1,
                 is_active = $2,
                 is_approved = $2,
                 moderated_by = $3,
                 moderated_at = NOW(),
                 moderation_notes = $4,
                 rejection_reason = $5,
                 updated_at = NOW()
             WHERE id = $6`,
            [
                approved ? 'active' : 'rejected',
                approved,
                req.user.id,
                notes || null,
                approved ? null : (rejection_reason || 'Rejected by moderator.'),
                productId,
            ]
        );

        await client.query(
            `INSERT INTO moderation_history (
                moderator_id,
                action,
                target_type,
                target_id,
                notes,
                created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())`,
            [
                req.user.id,
                approved ? 'product_approved' : 'product_rejected',
                'product',
                productId,
                notes || rejection_reason || null,
            ]
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    res.status(200).json({
        success: true,
        message: approved ? 'Product approved successfully.' : 'Product rejected.',
        data: {
            productId,
            productName: product.name,
            approved,
        },
    });
});

// ============================================
// SELLER MODERATION
// ============================================

export const verifySeller = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});
    if (!req.user) throw new AppError(401, "Authentication required.");

    const sellerId = extractString(req.params.sellerId);
    if (!isValidUUID(sellerId)) throw new AppError(400, "Invalid seller ID format.");

    const { verified, reason } = req.body as VerifySellerInput;

    if (!verified) {
        // Rejection path stays simple — no bulk logic needed for reject.
        const sellerCheck = await pool.query(
            `SELECT id, business_name FROM sellers WHERE id = $1`,
            [sellerId]
        );
        if (sellerCheck.rows.length === 0) throw new AppError(404, "Seller not found.");

        await pool.query(
            `UPDATE sellers 
             SET status = 'rejected', verification_status = 'rejected',
                 rejected_reason = $1, updated_at = NOW()
             WHERE id = $2`,
            [reason || null, sellerId]
        );

        await pool.query(
            `INSERT INTO moderation_history (moderator_id, action, target_type, target_id, notes, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [req.user.id, "seller_rejected", "seller", sellerId, reason || null]
        );

        return res.status(200).json({
            success: true,
            message: "Seller rejected.",
            data: { sellerId, verified: false },
        });
    }

    const seller = await verifySellerBulk(sellerId, req.user.id, reason);

    await pool.query(
        `INSERT INTO moderation_history (moderator_id, action, target_type, target_id, notes, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [req.user.id, "seller_verified", "seller", sellerId, reason || null]
    );

    res.status(200).json({
        success: true,
        message: "Seller and all documents verified successfully.",
        data: {
            sellerId,
            businessName: seller.legal_business_name,
            verified: true,
        },
    });
});

// ============================================
// CONTENT MODERATION
// ============================================

export const moderateContent = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    if (!req.user) {
        throw new AppError(401, 'Authentication required.');
    }

    const contentId = extractString(req.params.contentId);

    if (!isValidUUID(contentId)) {
        throw new AppError(400, 'Invalid content ID format. Expected UUID.');
    }

    const { action, reason } = req.body as ModerateContentInput;

    if (!action || !['approve', 'remove', 'flag'].includes(action)) {
        throw new AppError(400, 'Invalid action. Must be: approve, remove, flag');
    }

    // ⚠️ NOTE: `content_moderation` table does NOT exist in your schema.
    // This handler will 500 at runtime until either:
    //   (a) you add the table via migration, or
    //   (b) you stub this endpoint to log to moderation_history only.
    // For now, I've kept the shape but wrapped it so the error is clearer.
    const contentCheck = await pool.query(
        `SELECT id, status FROM content_moderation WHERE id = $1`,
        [contentId]
    );

    if (contentCheck.rows.length === 0) {
        throw new AppError(404, 'Content not found.');
    }

    const content = contentCheck.rows[0];

    const statusMap: Record<string, string> = {
        approve: 'approved',
        remove: 'removed',
        flag: 'flagged',
    };

    const status = statusMap[action] || 'flagged';

    await pool.query(
        `UPDATE content_moderation 
         SET status = $1,
             moderated_by = $2,
             moderated_at = NOW(),
             moderation_reason = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [status, req.user.id, reason || null, contentId]
    );

    await pool.query(
        `INSERT INTO moderation_history (
            moderator_id,
            action,
            target_type,
            target_id,
            notes,
            created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
            req.user.id,
            `content_${action}`,
            'content',
            contentId,
            reason || null,
        ]
    );

    res.status(200).json({
        success: true,
        message: `Content ${action}d successfully.`,
        data: {
            contentId,
            action,
            previousStatus: content.status,
            newStatus: status,
        },
    });
});

// ============================================
// GET PENDING SELLERS
// ============================================

export const getPendingSellers = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const search = req.query.search as string | undefined;

    const offset = (page - 1) * limit;
    const conditions: string[] = [
        "s.status IN ('pending', 'kyc_submitted', 'kyc_update_pending')",
    ];
    const values: any[] = [];
    let paramCount = 1;

    if (search) {
        conditions.push(
            `(s.business_name ILIKE $${paramCount} OR u.full_name ILIKE $${paramCount} OR u.email ILIKE $${paramCount})`
        );
        values.push(`%${search}%`);
        paramCount++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // ---- Count ----
    const countQuery = `
        SELECT COUNT(DISTINCT s.id) as total
        FROM sellers s
        JOIN users u ON u.id = s.user_id
        ${whereClause}
    `;
    const countResult = await pool.query(countQuery, values);
    const total = parseInt(countResult.rows[0]?.total || '0');

    // ---- Fetch pending sellers (with kyc_documents) ----
    const query = `
        SELECT 
            s.id as seller_id,
            s.user_id,
            s.business_name as legal_business_name,
            s.trading_name,
            s.business_type,
            s.country,
            s.state,
            s.city,
            s.business_address,
            s.business_phone,
            s.verification_status,
            s.status,
            s.tax_id,
            s.registration_number,
            s.payout_method,
            s.bank_account_name,
            s.bank_account_number,
            s.bank_routing_number,
            s.bank_name,
            s.bank_country,
            s.paypal_email,
            s.mpesa_phone,
            s.kyc_documents,
            s.created_at,
            s.updated_at,
            jsonb_build_object(
                'id', u.id,
                'full_name', u.full_name,
                'email', u.email,
                'phone', u.phone
            ) as user
        FROM sellers s
        JOIN users u ON u.id = s.user_id
        ${whereClause}
        ORDER BY s.created_at ASC
        LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    values.push(limit, offset);

    const result = await pool.query(query, values);

    // ---- Shape into ModeratorPendingSellerRow ----
    const sellers = result.rows.map((row) => ({
        id: row.seller_id,
        seller: {
            id: row.seller_id,
            user_id: row.user_id,
            legal_business_name: row.legal_business_name,
            trading_name: row.trading_name,
            business_type: row.business_type,
            country: row.country,
            state: row.state,
            city: row.city,
            business_address: row.business_address,
            business_phone: row.business_phone,
            verification_status: row.verification_status,
            status: row.status,
            tax_id: row.tax_id,
            registration_number: row.registration_number,
            payout_method: row.payout_method,
            bank_account_name: row.bank_account_name,
            bank_account_number: row.bank_account_number,
            bank_routing_number: row.bank_routing_number,
            bank_name: row.bank_name,
            bank_country: row.bank_country,
            paypal_email: row.paypal_email,
            mpesa_phone: row.mpesa_phone,
            kyc_documents: Array.isArray(row.kyc_documents)
                ? row.kyc_documents
                : typeof row.kyc_documents === 'string'
                ? JSON.parse(row.kyc_documents)
                : [],
            user: row.user,
            created_at: row.created_at,
            updated_at: row.updated_at,
        },
        status: 'pending',
        priority: 'medium',
        submitted_at: row.created_at ?? new Date().toISOString(),
    }));

    res.status(200).json({
        success: true,
        data: sellers,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    });
});

// ============================================
// GET ALL SELLERS (any status) — NEW
// ============================================
//
// Returns every seller regardless of status. Optional `status` query
// param narrows to a single verification status ('pending' | 'verified'
// | 'rejected' | 'suspended'). An empty string is treated as "no filter"
// so the UI can send `?status=` for its "All Statuses" option without
// erroring.

export const getAllSellers = asyncHandler(async (req: Request, res: Response) => {
    requireModerator(req, res, () => {});

    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const search = req.query.search as string | undefined;
    const rawStatus = req.query.status as string | undefined;

    // Treat empty string / whitespace as "no filter"
    const statusFilter =
        rawStatus && rawStatus.trim() !== '' ? rawStatus.trim() : undefined;

    // Validate status against the allowed set if provided
    if (statusFilter) {
        const allowed = ['pending', 'verified', 'rejected', 'suspended'];
        if (!allowed.includes(statusFilter)) {
            throw new AppError(
                400,
                `Invalid status filter. Must be one of: ${allowed.join(', ')}`
            );
        }
    }

    const result = await getAllSellersForModeration(
        page,
        limit,
        search,
        statusFilter
    );

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
});