// src/features/order/order.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import {
  createOrder,
  createOrdersFromCart,
  getOrderById,
  getOrderByNumber,
  getOrders,
  updateOrder,
  cancelOrder,
  getOrderMetrics,
} from './order.service';
import { checkSellerStatus, getSellerByUserId } from '../seller/seller.service';
import {
  CreateOrderInput,
  UpdateOrderInput,
  GetOrdersQuery,
} from './order.types';
import type { CheckoutBody } from './order.validator';
import { getStoreById } from '../store/store.service';

// ============================================
// HELPERS
// ============================================

const extractString = (param: string | string[] | undefined): string => {
  if (!param) throw new AppError(400, 'Parameter is required');
  return Array.isArray(param) ? param[0] : param;
};

const isValidUUID = (id: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
};

const requireUser = (req: Request): NonNullable<Request['user']> => {
  if (!req.user) throw new AppError(401, 'Authentication required.');
  return req.user;
};

const requireActiveSeller = async (userId: string) => {
  const seller = await getSellerByUserId(userId);
  if (!seller) {
    throw new AppError(404, 'Seller profile not found.');
  }

  const status = await checkSellerStatus(seller.id);
  if (!status.is_active) {
    throw new AppError(
      403,
      status.block_reason || 'Your seller account is not active.',
    );
  }

  return { seller, status };
};

// ============================================
// CHECKOUT — CART → ORDERS
// ============================================

export const checkoutHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);
    const input = req.body as CheckoutBody;


    const result = await createOrdersFromCart(user.id, input);


    res.status(201).json({
      success: true,
      message:
        result.orders.length === 1
          ? 'Order created. Proceed to payment.'
          : `${result.orders.length} orders created. Proceed to payment.`,
      data: {
        orders: result.orders,
        total: result.total,
        currency: result.currency,
        payment_group_id: result.payment_group_id,
      },
    });
  },
);

// ============================================
// CREATE ORDER (admin / manual)
// ============================================

export const createOrderHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);
    const input = req.body as CreateOrderInput;

    const store = await getStoreById(input.store_id);
    if (!store) {
      throw new AppError(404, 'Store not found.');
    }

    if (store.status !== 'active') {
      throw new AppError(403, 'Store is not accepting orders at this time.');
    }

    const order = await createOrder(user.id, input);

    res.status(201).json({
      success: true,
      message: 'Order created successfully.',
      data: order,
    });
  },
);

// ============================================
// GET ORDER BY ID
// ============================================

export const getOrderHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const orderId = extractString(req.params.orderId);

    if (!isValidUUID(orderId)) {
      throw new AppError(400, 'Invalid order ID format.');
    }

    const order = await getOrderById(orderId, req.user?.id, req.user?.role);

    if (!order) {
      throw new AppError(404, 'Order not found.');
    }

    res.status(200).json({ success: true, data: order });
  },
);

// ============================================
// GET ORDER BY NUMBER
// ============================================

export const getOrderByNumberHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const orderNumber = extractString(req.params.orderNumber);

    const order = await getOrderByNumber(
      orderNumber,
      req.user?.id,
      req.user?.role,
    );

    if (!order) {
      throw new AppError(404, 'Order not found.');
    }

    res.status(200).json({ success: true, data: order });
  },
);

// ============================================
// GET ORDERS
// ============================================

export const getOrdersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const query = req.query as unknown as GetOrdersQuery;
    const userId = req.user?.id;
    const role = req.user?.role;

    const result = await getOrders(query, userId, role);

    res.status(200).json({
      success: true,
      data: result.orders,
      summary: result.summary,
      pagination: result.pagination,
    });
  },
);

// ============================================
// GET MY ORDERS (buyer)
// ============================================

export const getMyOrdersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const query = req.query as unknown as GetOrdersQuery;
    const result = await getOrders(
      { ...query, user_id: user.id },
      user.id,
      user.role,
    );

    res.status(200).json({
      success: true,
      data: result.orders,
      summary: result.summary,
      pagination: result.pagination,
    });
  },
);

// ============================================
// GET STORE ORDERS (seller)
// ============================================

export const getStoreOrdersHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);
    if (user.role !== 'seller') {
      throw new AppError(403, 'Only sellers can view store orders.');
    }

    const storeId = extractString(req.params.storeId);
    if (!isValidUUID(storeId)) {
      throw new AppError(400, 'Invalid store ID format.');
    }

    const store = await getStoreById(storeId);
    if (!store) {
      throw new AppError(404, 'Store not found.');
    }

    await requireActiveSeller(user.id);

    const query = req.query as unknown as GetOrdersQuery;
    const result = await getOrders(
      { ...query, store_id: storeId },
      user.id,
      user.role,
    );

    res.status(200).json({
      success: true,
      data: result.orders,
      summary: result.summary,
      pagination: result.pagination,
    });
  },
);

// ============================================
// UPDATE ORDER
// ============================================

export const updateOrderHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const orderId = extractString(req.params.orderId);
    if (!isValidUUID(orderId)) {
      throw new AppError(400, 'Invalid order ID format.');
    }

    const input = req.body as UpdateOrderInput;
    const order = await updateOrder(orderId, user.id, input, user.role);

    res.status(200).json({
      success: true,
      message: 'Order updated successfully.',
      data: order,
    });
  },
);

// ============================================
// CANCEL ORDER
// ============================================

export const cancelOrderHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const user = requireUser(req);

    const orderId = extractString(req.params.orderId);
    if (!isValidUUID(orderId)) {
      throw new AppError(400, 'Invalid order ID format.');
    }

    const { reason } = req.body ?? {};
    const order = await cancelOrder(orderId, user.id, reason, user.role);

    res.status(200).json({
      success: true,
      message: 'Order cancelled successfully.',
      data: order,
    });
  },
);

// ============================================
// ORDER METRICS
// ============================================

export const getOrderMetricsHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const orderId = extractString(req.params.orderId);
    if (!isValidUUID(orderId)) {
      throw new AppError(400, 'Invalid order ID format.');
    }

    const period =
      (req.query.period as 'today' | 'week' | 'month' | 'year' | 'all') ||
      'month';
    const metrics = await getOrderMetrics(orderId, period);

    res.status(200).json({ success: true, data: metrics });
  },
);