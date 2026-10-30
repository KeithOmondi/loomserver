// src/features/order/order.service.ts

import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import {
  Order,
  OrderStatus,
  OrderItem,
  OrderAddress,
  OrderShipping,
  OrderPayment,
  CreateOrderInput,
  UpdateOrderInput,
  GetOrdersQuery,
  OrderMetrics,
  isStatusTransitionValid,
} from './order.types';
import { getProductById } from '../products/product.service';
import { CheckoutBody } from './order.validator';
import { cancelOrderWithRefund } from './order-lifecycle.service';

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_LIMIT = 20;
const ORDER_PREFIX = 'ORD';
const DEFAULT_CURRENCY = 'KES';

// ============================================
// HELPERS
// ============================================

export const generateOrderNumber = async (client: PoolClient): Promise<string> => {
  const year = new Date().getFullYear();
  const result = await client.query<{ n: string }>(
    `SELECT nextval('order_number_seq')::text AS n`,
  );
  const seq = String(result.rows[0].n).padStart(6, '0');
  return `${ORDER_PREFIX}-${year}-${seq}`;
};

export const mapRowToOrder = (row: any): Order => ({
  id: row.id,
  order_number: row.order_number,
  store_id: row.store_id,
  user_id: row.user_id,
  seller_id: row.seller_id,
  customer: row.customer,
  items: row.items || [],
  subtotal: parseFloat(row.subtotal),
  discount_total: parseFloat(row.discount_total || 0),
  tax_total: parseFloat(row.tax_total || 0),
  shipping_total: parseFloat(row.shipping_total || 0),
  total: parseFloat(row.total),
  currency: row.currency || DEFAULT_CURRENCY,
  shipping: row.shipping,
  payment: row.payment,
  status: row.status,
  fulfillment_status: row.fulfillment_status,
  payment_status: row.payment_status,
  customer_notes: row.customer_notes,
  seller_notes: row.seller_notes,
  admin_notes: row.admin_notes,
  placed_at: row.placed_at,
  payment_confirmed_at: row.payment_confirmed_at,
  processed_at: row.processed_at,
  shipped_at: row.shipped_at,
  delivered_at: row.delivered_at,
  completed_at: row.completed_at,
  cancelled_at: row.cancelled_at,
  refunded_at: row.refunded_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
  deleted_at: row.deleted_at,
  // fulfilment / escrow fields added with the escrow system
  ...({
    tracking_number: row.tracking_number ?? null,
    carrier: row.carrier ?? null,
    delivery_confirmed_at: row.delivery_confirmed_at ?? null,
    auto_confirm_at: row.auto_confirm_at ?? null,
    escrow_status: row.escrow_status ?? 'none',
    coupon_code: row.coupon_code ?? null,
    expires_at: row.expires_at ?? null,
    payment_group_id: row.payment_group_id ?? null,
  } as object),
});

// ============================================
// CREATE ORDERS FROM CART
// ============================================

interface CartRow {
  cart_id: string;
  cart_item_id: string;
  product_id: string;
  quantity: number;
  unit_price: string;
  product_name: string;
  product_slug: string;
  product_sku: string | null;
  product_image: string | null;
  product_status: string;
  product_is_active: boolean;
  product_stock_quantity: number;
  store_id: string;
  store_name: string;
  seller_id: string;
  buyer_id: string;
  buyer_full_name: string;
  buyer_email: string;
  buyer_phone: string | null;
}

export const resolveShippingAddress = async (
  client: PoolClient,
  userId: string,
  checkout: CheckoutBody,
  buyer: { full_name: string; email: string; phone: string | null },
): Promise<OrderAddress> => {

  if (checkout.address_id) {

    const result = await client.query(
      `SELECT * FROM addresses WHERE id = $1 AND user_id = $2`,
      [checkout.address_id, userId],
    );


    if (result.rows.length === 0) {
      throw new AppError(404, 'Saved address not found.');
    }
    const addr = result.rows[0];
    return {
      first_name: addr.first_name,
      last_name: addr.last_name,
      email: addr.email,
      phone: addr.phone,
      company: addr.company ?? undefined,
      address_line1: addr.address_line1,
      address_line2: addr.address_line2 ?? undefined,
      city: addr.city,
      state: addr.state ?? undefined,
      postal_code: addr.postal_code,
      country: addr.country,
      instructions: addr.instructions ?? undefined,
      source_address_id: addr.id,
    };
  }

  if (checkout.shipping_address) {
    const a = checkout.shipping_address;
    return {
      first_name: a.first_name,
      last_name: a.last_name,
      email: a.email,
      phone: a.phone,
      company: a.company ?? undefined,
      address_line1: a.address_line1,
      address_line2: a.address_line2 ?? undefined,
      city: a.city,
      state: a.state ?? undefined,
      postal_code: a.postal_code,
      country: a.country ?? 'KE',
      instructions: a.instructions ?? undefined,
    };
  }

  throw new AppError(400, 'Shipping address is required.');
};

// createOrdersFromCart now lives in ./checkout.service (live prices, shipping, coupons, commission).

// ============================================
// CREATE ORDER (admin / manual)
// ============================================

export const createOrder = async (
  userId: string,
  input: CreateOrderInput,
): Promise<Order> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const storeResult = await client.query(
      `SELECT id, seller_id FROM stores WHERE id = $1 AND deleted_at IS NULL`,
      [input.store_id],
    );
    if (storeResult.rows.length === 0) {
      throw new AppError(404, 'Store not found.');
    }
    const store = storeResult.rows[0];

    const buyerResult = await client.query<{
      full_name: string;
      email: string;
      phone: string | null;
    }>(
      `SELECT full_name, email, phone FROM users WHERE id = $1`,
      [userId],
    );
    const buyer = buyerResult.rows[0];
    const [firstName, ...restName] = (buyer?.full_name || '').split(' ');
    const customerSnapshot = {
      first_name: firstName ?? '',
      last_name: restName.join(' ') || '',
      email: buyer?.email ?? '',
      phone: buyer?.phone ?? '',
    };

    let subtotal = 0;
    const orderItemsJson: OrderItem[] = [];

    for (const item of input.items) {
      const product = await getProductById(item.product_id);
      if (!product) {
        throw new AppError(404, `Product ${item.product_id} not found.`);
      }
      if (product.store_id !== input.store_id) {
        throw new AppError(400, `Product ${product.name} does not belong to this store.`);
      }
      if (!product.is_active || product.status !== 'active') {
        throw new AppError(400, `Product ${product.name} is not available.`);
      }
      if (product.stock_quantity < item.quantity) {
        throw new AppError(
          400,
          `Insufficient stock for ${product.name}. Available: ${product.stock_quantity}`,
        );
      }

      const unitPrice = product.price;
      const lineTotal = unitPrice * item.quantity;
      subtotal += lineTotal;

      orderItemsJson.push({
        id: '',
        order_id: '',
        product_id: product.id,
        variant_id: item.variant_id,
        product_name: product.name,
        variant_name: undefined,
        sku: product.sku ?? '',
        quantity: item.quantity,
        price: unitPrice,
        total: lineTotal,
        discount_amount: 0,
        tax_amount: 0,
        tax_rate: 0,
        metadata: undefined,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    const taxTotal = 0;
    const shippingTotal = 0;
    const discountTotal = 0;
    const orderTotal = subtotal + taxTotal + shippingTotal - discountTotal;

    const orderNumber = await generateOrderNumber(client);

    const shippingSnapshot: OrderShipping = {
      method: input.shipping.method,
      cost: shippingTotal,
      estimated_days: 5,
      address: input.shipping.address,
    };

    const paymentSnapshot: OrderPayment = {
      method: input.payment.method,
      status: 'pending',
      amount: orderTotal,
      currency: input.currency ?? DEFAULT_CURRENCY,
    };

    const orderResult = await client.query(
      `INSERT INTO orders (
         order_number, store_id, user_id, seller_id,
         customer, items, subtotal, discount_total,
         tax_total, shipping_total, total, currency,
         shipping, payment, status, fulfillment_status,
         payment_status, customer_notes, placed_at,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4,
         $5::jsonb, $6::jsonb, $7, $8,
         $9, $10, $11, $12,
         $13::jsonb, $14::jsonb, $15, $16,
         $17, $18, NOW(), NOW(), NOW()
       )
       RETURNING *`,
      [
        orderNumber,
        input.store_id,
        userId,
        store.seller_id,
        JSON.stringify(customerSnapshot),
        JSON.stringify(orderItemsJson),
        subtotal,
        discountTotal,
        taxTotal,
        shippingTotal,
        orderTotal,
        input.currency ?? DEFAULT_CURRENCY,
        JSON.stringify(shippingSnapshot),
        JSON.stringify(paymentSnapshot),
        'pending',
        'unfulfilled',
        'pending',
        input.customer_notes ?? null,
      ],
    );

    const order = mapRowToOrder(orderResult.rows[0]);

    for (const item of orderItemsJson) {
      await client.query(
        `INSERT INTO order_items (
           order_id, product_id, variant_id, quantity, price, total
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          order.id,
          item.product_id,
          item.variant_id ?? null,
          item.quantity,
          item.price,
          item.total,
        ],
      );
      await client.query(
        `UPDATE products
         SET stock_quantity = stock_quantity - $1, updated_at = NOW()
         WHERE id = $2`,
        [item.quantity, item.product_id],
      );
    }

    await client.query('COMMIT');
    return order;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// GET ORDER BY ID
// ============================================

export const getOrderById = async (
  orderId: string,
  userId?: string,
  role?: string,
): Promise<Order | null> => {
  let query = `SELECT * FROM orders WHERE id = $1 AND deleted_at IS NULL`;
  const params: any[] = [orderId];

  // Buyers can only fetch their own orders. Sellers, moderators, admins,
  // and super_admins bypass this — the caller is responsible for
  // authorizing which orders they're allowed to see.
  if (
    userId &&
    role !== 'admin' &&
    role !== 'super_admin' &&
    role !== 'moderator' &&
    role !== 'seller'
  ) {
    query += ` AND user_id = $2`;
    params.push(userId);
  }

  const result = await pool.query(query, params);
  return result.rows.length > 0 ? mapRowToOrder(result.rows[0]) : null;
};

// ============================================
// GET ORDER BY NUMBER
// ============================================

export const getOrderByNumber = async (
  orderNumber: string,
  userId?: string,
  role?: string,
): Promise<Order | null> => {
  let query = `SELECT * FROM orders WHERE order_number = $1 AND deleted_at IS NULL`;
  const params: any[] = [orderNumber];

  if (
    userId &&
    role !== 'admin' &&
    role !== 'super_admin' &&
    role !== 'moderator' &&
    role !== 'seller'
  ) {
    query += ` AND user_id = $2`;
    params.push(userId);
  }

  const result = await pool.query(query, params);
  return result.rows.length > 0 ? mapRowToOrder(result.rows[0]) : null;
};

// ============================================
// GET ORDERS
// ============================================

export const getOrders = async (
  query: GetOrdersQuery,
  userId?: string,
  role?: string,
): Promise<{ orders: Order[]; summary: any; pagination: any }> => {
  const {
    page = 1,
    limit = DEFAULT_LIMIT,
    search,
    status,
    payment_status,
    fulfillment_status,
    store_id,
    seller_id,
    user_id,
    min_total,
    max_total,
    date_from,
    date_to,
    sortBy = 'created_at',
    sortOrder = 'desc',
  } = query;

  const offset = (page - 1) * limit;
  const conditions: string[] = ['deleted_at IS NULL'];
  const values: any[] = [];
  let paramCount = 1;

  // ⚠️ IMPORTANT — do NOT auto-apply user_id for sellers.
  //
  // `user_id` on an order is the *buyer*. Sellers querying their store's
  // orders must not be filtered by it, or the seller will only ever see
  // orders where they themselves were the buyer (usually none).
  //
  // Explicit scoping is up to the caller:
  //   - Buyers: getMyOrdersHandler passes `user_id` in the query.
  //   - Sellers: getStoreOrdersHandler passes `store_id`.
  //   - Admins/moderators: no filter — see everything.
  //
  // The role check below only handles the *defensive* case where a buyer
  // reaches this function without having passed `user_id` explicitly.
  if (
    userId &&
    !user_id &&
    !store_id &&
    !seller_id &&
    role !== 'admin' &&
    role !== 'super_admin' &&
    role !== 'moderator' &&
    role !== 'seller'
  ) {
    conditions.push(`user_id = $${paramCount++}`);
    values.push(userId);
  }

  if (user_id) {
    conditions.push(`user_id = $${paramCount++}`);
    values.push(user_id);
  }
  if (store_id) {
    conditions.push(`store_id = $${paramCount++}`);
    values.push(store_id);
  }
  if (seller_id) {
    conditions.push(`seller_id = $${paramCount++}`);
    values.push(seller_id);
  }
  if (status && status.length > 0) {
    conditions.push(`status = ANY($${paramCount++}::text[])`);
    values.push(status);
  }
  if (payment_status) {
    conditions.push(`payment_status = $${paramCount++}`);
    values.push(payment_status);
  }
  if (fulfillment_status) {
    conditions.push(`fulfillment_status = $${paramCount++}`);
    values.push(fulfillment_status);
  }
  if (min_total !== undefined) {
    conditions.push(`total >= $${paramCount++}`);
    values.push(min_total);
  }
  if (max_total !== undefined) {
    conditions.push(`total <= $${paramCount++}`);
    values.push(max_total);
  }
  if (date_from) {
    conditions.push(`created_at >= $${paramCount++}`);
    values.push(date_from);
  }
  if (date_to) {
    conditions.push(`created_at <= $${paramCount++}`);
    values.push(date_to);
  }
  if (search) {
    conditions.push(`(
      order_number ILIKE $${paramCount} OR
      customer->>'first_name' ILIKE $${paramCount} OR
      customer->>'last_name' ILIKE $${paramCount} OR
      customer->>'email' ILIKE $${paramCount}
    )`);
    values.push(`%${search}%`);
    paramCount++;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const totalsResult = await pool.query<{
    total: number;
    total_revenue: number;
  }>(
    `SELECT
       COUNT(*)::int AS total,
       COALESCE(SUM(total), 0)::float AS total_revenue
     FROM orders ${whereClause}`,
    values,
  );
  const totalCount = totalsResult.rows[0].total;
  const totalRevenue = totalsResult.rows[0].total_revenue;

  const statusResult = await pool.query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int AS count
     FROM orders ${whereClause}
     GROUP BY status`,
    values,
  );
  const statusBreakdown: Record<string, number> = {};
  for (const row of statusResult.rows) {
    statusBreakdown[row.status] = row.count;
  }

  const listValues = [...values, limit, offset];
  const listResult = await pool.query(
    `SELECT * FROM orders
     ${whereClause}
     ORDER BY ${sortBy} ${sortOrder}
     LIMIT $${paramCount} OFFSET $${paramCount + 1}`,
    listValues,
  );

  return {
    orders: listResult.rows.map(mapRowToOrder),
    summary: {
      total: totalCount,
      total_revenue: totalRevenue,
      status_breakdown: statusBreakdown,
    },
    pagination: {
      page,
      limit,
      total: totalCount,
      pages: Math.ceil(totalCount / limit),
    },
  };
};

// ============================================
// UPDATE ORDER
// ============================================

export const updateOrder = async (
  orderId: string,
  userId: string,
  input: UpdateOrderInput,
  role: string,
): Promise<Order> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const order = await getOrderById(orderId);
    if (!order) {
      throw new AppError(404, 'Order not found.');
    }

    // Buyers and sellers use the dedicated actions (cancel / ship / deliver / confirm) so escrow,
    // stock and notifications stay consistent with the status. This generic update is staff-only.
    if (role !== 'admin' && role !== 'super_admin') {
      throw new AppError(403, 'You do not have permission to update this order.');
    }
    void userId;

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.status) {
      if (['paid', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'].includes(input.status)) {
        throw new AppError(400, `Use the dedicated action to set "${input.status}" so payments and stock stay correct.`);
      }
      if (!isStatusTransitionValid(order.status, input.status)) {
        throw new AppError(
          400,
          `Invalid status transition: ${order.status} -> ${input.status}`,
        );
      }
      updates.push(`status = $${paramCount++}`);
      values.push(input.status);

      const statusTimestampMap: Record<OrderStatus, string> = {
        'pending': 'placed_at',
        'payment_pending': 'payment_confirmed_at',
        'paid': 'payment_confirmed_at',
        'processing': 'processed_at',
        'shipped': 'shipped_at',
        'delivered': 'delivered_at',
        'completed': 'completed_at',
        'cancelled': 'cancelled_at',
        'refunded': 'refunded_at',
        'failed': 'payment_confirmed_at',
      };
      if (statusTimestampMap[input.status]) {
        updates.push(`${statusTimestampMap[input.status]} = NOW()`);
      }
    }

    if (input.fulfillment_status) {
      updates.push(`fulfillment_status = $${paramCount++}`);
      values.push(input.fulfillment_status);
    }
    if (input.payment_status) {
      updates.push(`payment_status = $${paramCount++}`);
      values.push(input.payment_status);
    }
    if (input.shipping_tracking) {
      const tracking = {
        ...order.shipping,
        carrier: input.shipping_tracking.carrier,
        tracking_number: input.shipping_tracking.tracking_number,
        tracking_url: input.shipping_tracking.tracking_url,
        shipped_at: order.shipping.shipped_at || new Date(),
      };
      updates.push(`shipping = $${paramCount++}::jsonb`);
      values.push(JSON.stringify(tracking));
    }
    if (input.customer_notes !== undefined) {
      updates.push(`customer_notes = $${paramCount++}`);
      values.push(input.customer_notes);
    }
    if (input.seller_notes !== undefined) {
      updates.push(`seller_notes = $${paramCount++}`);
      values.push(input.seller_notes);
    }
    if (input.admin_notes !== undefined) {
      updates.push(`admin_notes = $${paramCount++}`);
      values.push(input.admin_notes);
    }

    if (updates.length === 0) {
      throw new AppError(400, 'No fields to update.');
    }

    updates.push(`updated_at = NOW()`);
    values.push(orderId);

    const result = await client.query(
      `UPDATE orders
       SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values,
    );

    await client.query('COMMIT');
    return mapRowToOrder(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// CANCEL ORDER
// ============================================

export const cancelOrder = async (
  orderId: string,
  userId: string,
  reason?: string,
  role?: string,
): Promise<Order> => {
  await cancelOrderWithRefund(orderId, { id: userId, role: role ?? 'customer' }, reason);
  const updated = await getOrderById(orderId);
  if (!updated) throw new AppError(404, 'Order not found.');
  return updated;
};

// ============================================
// PAYMENT GROUP HELPERS
// ============================================

export { markPaymentGroupPaid, markPaymentGroupFailed } from './order-lifecycle.service';

// ============================================
// ORDER METRICS
// ============================================

export const getOrderMetrics = async (
  orderId: string,
  period: 'today' | 'week' | 'month' | 'year' | 'all' = 'month',
): Promise<OrderMetrics> => {
  const now = new Date();
  let startDate: Date;

  switch (period) {
    case 'today':
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'week':
      startDate = new Date(now);
      startDate.setDate(now.getDate() - 7);
      break;
    case 'month':
      startDate = new Date(now);
      startDate.setMonth(now.getMonth() - 1);
      break;
    case 'year':
      startDate = new Date(now);
      startDate.setFullYear(now.getFullYear() - 1);
      break;
    default:
      startDate = new Date(0);
  }

  const result = await pool.query(
    `SELECT
      COUNT(*) as total_orders,
      COALESCE(SUM(total), 0) as total_revenue,
      COALESCE(AVG(total), 0) as average_order_value,
      0 as conversion_rate,
      CASE
        WHEN COUNT(*) > 0
        THEN (COUNT(CASE WHEN status = 'cancelled' THEN 1 END)::float / COUNT(*) * 100)
        ELSE 0
      END as cancelled_rate,
      CASE
        WHEN COUNT(*) > 0
        THEN (COUNT(CASE WHEN status = 'refunded' THEN 1 END)::float / COUNT(*) * 100)
        ELSE 0
      END as return_rate
    FROM orders
    WHERE id = $1 AND created_at >= $2 AND deleted_at IS NULL`,
    [orderId, startDate],
  );

  const row = result.rows[0];

  return {
    order_id: orderId,
    period,
    total_orders: parseInt(row.total_orders || 0),
    total_revenue: parseFloat(row.total_revenue || 0),
    average_order_value: parseFloat(row.average_order_value || 0),
    conversion_rate: parseFloat(row.conversion_rate || 0),
    cancelled_rate: parseFloat(row.cancelled_rate || 0),
    return_rate: parseFloat(row.return_rate || 0),
  };
};