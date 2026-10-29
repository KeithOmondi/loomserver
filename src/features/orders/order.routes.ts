// src/features/order/order.routes.ts

import { Router } from 'express';
import {
  protect,
  requireAdmin,
  requireModerator,
} from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  checkoutSchema,
  createOrderSchema,
  updateOrderSchema,
  updateOrderStatusSchema,
  getOrdersQuerySchema,
  orderMetricsSchema,
  orderIdParamSchema,
} from './order.validator';
import {
  checkoutHandler,
  createOrderHandler,
  getOrderHandler,
  getOrderByNumberHandler,
  getOrdersHandler,
  getMyOrdersHandler,
  getStoreOrdersHandler,
  updateOrderHandler,
  cancelOrderHandler,
  getOrderMetricsHandler,
} from './order.controller';

const router = Router();

// ============================================================
// ROUTE ORDER
//
// Express matches top-down, first match wins. Every route must be
// registered in this order:
//
//   1. Static single-segment     (/my, /checkout)
//   2. Fully-nested static       (/admin/..., /moderator/..., /stores/...)
//   3. Nested under /:orderId    (/:orderId/metrics, /:orderId/cancel, ...)
//   4. Dynamic single-segment    (/:orderId, /number/:orderNumber)
//
// NOTE: '/number/:orderNumber' has two segments so it isn't shadowed by
// '/:orderId' — but it MUST still come before any wildcard that could
// match two segments.
// ============================================================

// ============================================================
// 1. STATIC SINGLE-SEGMENT
// ============================================================

/**
 * GET /api/v1/orders/my
 * Get the current user's orders (buyer).
 */
router.get('/my', protect, getMyOrdersHandler);

/**
 * POST /api/v1/orders/checkout
 * Convert the current user's cart into one or more orders.
 *
 * ✅ MUST come before /:orderId — otherwise 'checkout' is treated as
 * an order id.
 */
router.post(
  '/checkout',
  protect,
  validate(checkoutSchema),
  checkoutHandler,
);

/**
 * POST /api/v1/orders
 * Create a manual order (admin-only helper; buyers use /checkout).
 */
router.post(
  '/',
  protect,
  validate(createOrderSchema),
  createOrderHandler,
);

// ============================================================
// 2. FULLY-NESTED STATIC PREFIXES
// ============================================================

// ---- Seller ----

/**
 * GET /api/v1/orders/stores/:storeId
 * Orders for a specific store (seller-only).
 */
router.get('/stores/:storeId', protect, getStoreOrdersHandler);

// ---- Admin ----

/**
 * GET /api/v1/orders/admin/orders
 * All orders, admin view.
 */
router.get(
  '/admin/orders',
  protect,
  requireAdmin,
  validate(getOrdersQuerySchema),
  getOrdersHandler,
);

/**
 * PUT /api/v1/orders/admin/orders/:orderId/status
 * Update order status (admin override).
 */
router.put(
  '/admin/orders/:orderId/status',
  protect,
  requireAdmin,
  validate(updateOrderStatusSchema),
  updateOrderHandler,
);

// ---- Moderator ----

/**
 * GET /api/v1/orders/moderator/orders
 * Orders visible to moderators.
 */
router.get(
  '/moderator/orders',
  protect,
  requireModerator,
  validate(getOrdersQuerySchema),
  getOrdersHandler,
);

// ============================================================
// 3. LOOKUP BY ORDER NUMBER (two segments — static prefix)
// ============================================================

/**
 * GET /api/v1/orders/number/:orderNumber
 * Lookup an order by its human-readable number (ORD-2026-000123).
 *
 * Registered before /:orderId so 'number' isn't captured as an id.
 */
router.get(
  '/number/:orderNumber',
  protect,
  getOrderByNumberHandler,
);

// ============================================================
// 4. NESTED UNDER /:orderId (specific two-segment paths first)
// ============================================================

/**
 * GET /api/v1/orders/:orderId/metrics
 */
router.get(
  '/:orderId/metrics',
  protect,
  validate(orderMetricsSchema),
  getOrderMetricsHandler,
);

/**
 * POST /api/v1/orders/:orderId/cancel
 */
router.post(
  '/:orderId/cancel',
  protect,
  cancelOrderHandler,
);

/**
 * PATCH /api/v1/orders/:orderId
 * Seller or buyer updates an order.
 */
router.patch(
  '/:orderId',
  protect,
  validate(updateOrderSchema),
  updateOrderHandler,
);

// ============================================================
// 5. DYNAMIC SINGLE-SEGMENT (must come LAST)
// ============================================================

/**
 * GET /api/v1/orders/:orderId
 * Get a single order by id.
 */
router.get(
  '/:orderId',
  protect,
  validate(orderIdParamSchema),
  getOrderHandler,
);

export default router;