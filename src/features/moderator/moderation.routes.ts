// src/routes/moderator.routes.ts

import { Router } from 'express';
import { protect, requireModerator } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
    reviewStoreSchema,
    reviewProductSchema,
    verifySellerSchema,
    moderateContentSchema,
    // resolveDisputeSchema, // Commented out - uncomment when implemented
    bulkModerationSchema,
    moderationFiltersSchema,
    moderationHistoryFiltersSchema,
    updatePrioritySchema,
    getPendingStoresQuerySchema,
    getAllStoresQuerySchema,
    getPendingSellersQuerySchema,
    getAllSellersQuerySchema, // <-- NEW
} from './moderator.validator';
import {
    getDashboard,
    getQueue,
    getQueueSummary,
    getModerationItem,
    updatePriority,
    assignModerator,
    getStoreForReview,
    reviewStoreHandler,
    getProductForReview,
    reviewProduct,
    verifySeller,
    bulkModerate,
    getHistory,
    getStats,
    reportContent,
    getPendingStores,
    getAllStores,
    getStoreStats,
    getModeratorStats,
    moderateContent,
    getPendingSellers,
    getAllSellers, // <-- NEW
} from './moderation.controller';

const router = Router();

// ============================================
// All routes require authentication and moderator role
// ============================================

router.use(protect);
router.use(requireModerator);

// ============================================
// Dashboard
// ============================================

/**
 * GET /api/moderator/dashboard
 * Get moderator dashboard with stats, queue summary, and alerts
 */
router.get('/dashboard', getDashboard);

// ============================================
// Stats & Stores (Specific routes FIRST!)
// ============================================
//
// ⚠️ IMPORTANT ORDERING:
//   1. `/stats` — top-level stats
//   2. `/stores/stats` — store stats (MUST be before /stores/:storeId)
//   3. `/stores/pending` — pending stores (MUST be before /stores/:storeId)
//   4. `/stores` — all stores (MUST be before /stores/:storeId)
//   5. `/stores/:storeId` — parameterized (LAST)

/**
 * GET /api/moderator/stats
 * Get moderation statistics (moderation queue counts)
 */
router.get('/stats', getModeratorStats);

/**
 * GET /api/moderator/stores/stats
 * Get store-specific statistics for the Store Moderation page stat cards
 * ✅ MUST come before /stores/:storeId
 */
router.get('/stores/stats', getStoreStats);

/**
 * GET /api/moderator/stores/pending
 * Get pending stores for moderation (legacy, pending-only view)
 * ✅ MUST come before /stores/:storeId
 */
router.get(
    '/stores/pending',
    validate(getPendingStoresQuerySchema),
    getPendingStores
);

/**
 * GET /api/moderator/stores
 * Get ALL stores regardless of status (pending / approved / rejected /
 * suspended / in_review). Optional `?status=` query filters to one status.
 * ✅ MUST come before /stores/:storeId
 */
router.get(
    '/stores',
    validate(getAllStoresQuerySchema),
    getAllStores
);

// ============================================
// Seller Moderation (Specific routes FIRST!)
// ============================================
//
// ⚠️ IMPORTANT ORDERING:
//   1. `/sellers/pending` — pending sellers (MUST be before /sellers/:sellerId)
//   2. `/sellers` — all sellers (MUST be before /sellers/:sellerId)
//   3. `/sellers/:sellerId/verify` — parameterized (LAST)

/**
 * GET /api/moderator/sellers/pending
 * Get pending sellers for verification (legacy, pending-only view)
 * ✅ MUST come before /sellers/:sellerId
 */
router.get(
    '/sellers/pending',
    validate(getPendingSellersQuerySchema),
    getPendingSellers
);

/**
 * GET /api/moderator/sellers
 * Get ALL sellers regardless of status (pending / verified / rejected /
 * suspended). Optional `?status=` query filters to one status.
 * ✅ MUST come before /sellers/:sellerId
 */
router.get(
    '/sellers',
    validate(getAllSellersQuerySchema),
    getAllSellers
);

// ============================================
// Queue Management
// ============================================

/**
 * GET /api/moderator/queue
 * Get moderation queue with pagination and filters
 */
router.get('/queue', validate(moderationFiltersSchema), getQueue);

/**
 * GET /api/moderator/queue/summary
 * Get queue summary with counts by type and priority
 */
router.get('/queue/summary', getQueueSummary);

/**
 * GET /api/moderator/queue/:itemId
 * Get moderation item details by ID
 */
router.get('/queue/:itemId', getModerationItem);

/**
 * PATCH /api/moderator/queue/:itemId/priority
 * Update moderation item priority
 */
router.patch(
    '/queue/:itemId/priority',
    validate(updatePrioritySchema),
    updatePriority
);

/**
 * POST /api/moderator/queue/:itemId/assign
 * Assign a moderator to an item
 */
router.post(
    '/queue/:itemId/assign',
    assignModerator
);

// ============================================
// Store Moderation (Generic routes AFTER specific)
// ============================================

/**
 * GET /api/moderator/stores/:storeId
 * Get store details for review
 * ✅ MUST come AFTER /stores/stats, /stores/pending, and /stores
 */
router.get('/stores/:storeId', getStoreForReview);

/**
 * PUT /api/moderator/stores/:storeId/review
 * Review and approve/reject a store
 */
router.put(
    '/stores/:storeId/review',
    validate(reviewStoreSchema),
    reviewStoreHandler
);

// ============================================
// Product Moderation
// ============================================

/**
 * GET /api/moderator/products/:productId
 * Get product details for review
 */
router.get('/products/:productId', getProductForReview);

/**
 * PUT /api/moderator/products/:productId/review
 * Review and approve/reject a product
 */
router.put(
    '/products/:productId/review',
    validate(reviewProductSchema),
    reviewProduct
);

// ============================================
// Seller Moderation (Verify/Reject) — parameterized (LAST)
// ============================================

/**
 * PUT /api/moderator/sellers/:sellerId/verify
 * Verify or reject a seller
 * ✅ MUST come AFTER /sellers/pending and /sellers
 */
router.put(
    '/sellers/:sellerId/verify',
    validate(verifySellerSchema),
    verifySeller
);

// ============================================
// Content Moderation
// ============================================

/**
 * PUT /api/moderator/content/:contentId
 * Moderate content (approve, remove, flag)
 */
router.put(
    '/content/:contentId',
    validate(moderateContentSchema),
    moderateContent
);

// ============================================
// Reporting
// ============================================

/**
 * POST /api/moderator/report
 * Report content for moderation
 */
router.post('/report', reportContent);

// ============================================
// Bulk Moderation
// ============================================

/**
 * POST /api/moderator/bulk
 * Perform bulk moderation actions
 */
router.post(
    '/bulk',
    validate(bulkModerationSchema),
    bulkModerate
);

// ============================================
// History
// ============================================

/**
 * GET /api/moderator/history
 * Get moderation history with filters
 */
router.get('/history', validate(moderationHistoryFiltersSchema), getHistory);

export default router;