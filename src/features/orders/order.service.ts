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

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_LIMIT = 20;
const ORDER_PREFIX = 'ORD';
const DEFAULT_CURRENCY = 'KES';

// ============================================
// HELPERS
// ============================================

const generateOrderNumber = async (client: PoolClient): Promise<string> => {
  const year = new Date().getFullYear();
  const result = await client.query<{ n: string }>(
    `SELECT nextval('order_number_seq')::text AS n`,
  );
  const seq = String(result.rows[0].n).padStart(6, '0');
  return `${ORDER_PREFIX}-${year}-${seq}`;
};

const mapRowToOrder = (row: any): Order => ({
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

const resolveShippingAddress = async (
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

export const createOrdersFromCart = async (
  userId: string,
  checkout: CheckoutBody,
): Promise<{
  orders: Order[];
  total: number;
  currency: string;
  payment_group_id: string;
}> => {

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ---- 1. Load the buyer ----
    const buyerResult = await client.query<{
      id: string;
      full_name: string;
      email: string;
      phone: string | null;
    }>(
      `SELECT id, full_name, email, phone FROM users WHERE id = $1`,
      [userId],
    );
    if (buyerResult.rows.length === 0) {
      throw new AppError(404, 'User not found.');
    }
    const buyer = buyerResult.rows[0];

    // ---- 2. Load the cart ----
    const cartResult = await client.query<CartRow>(
      `SELECT
         c.id                              AS cart_id,
         ci.id                             AS cart_item_id,
         ci.product_id                     AS product_id,
         ci.quantity                       AS quantity,
         ci.unit_price                     AS unit_price,
         p.name                            AS product_name,
         p.slug                            AS product_slug,
         p.sku                             AS product_sku,
         p.status                          AS product_status,
         p.is_active                       AS product_is_active,
         p.stock_quantity                  AS product_stock_quantity,
         st.id                             AS store_id,
         st.name                           AS store_name,
         st.seller_id                      AS seller_id,
         img.url                           AS product_image,
         u.id                              AS buyer_id,
         u.full_name                       AS buyer_full_name,
         u.email                           AS buyer_email,
         u.phone                           AS buyer_phone
       FROM carts c
       JOIN cart_items  ci ON ci.cart_id = c.id
       JOIN products    p  ON p.id = ci.product_id
       JOIN stores      st ON st.id = p.store_id
       JOIN users       u  ON u.id = c.user_id
       LEFT JOIN LATERAL (
         SELECT url FROM product_images
         WHERE product_id = p.id
         ORDER BY is_primary DESC, sort_order ASC, created_at ASC
         LIMIT 1
       ) img ON TRUE
       WHERE c.user_id = $1
         AND p.deleted_at IS NULL`,
      [userId],
    );

    if (cartResult.rows.length === 0) {
      throw new AppError(400, 'Your cart is empty.');
    }

    // ---- 3. Validate every item ----
    for (const row of cartResult.rows) {
      if (!row.product_is_active || row.product_status !== 'active') {
        throw new AppError(
          400,
          `"${row.product_name}" is no longer available. Please remove it from your cart.`,
        );
      }
      if (row.product_stock_quantity < row.quantity) {
        throw new AppError(
          400,
          `Insufficient stock for "${row.product_name}". Available: ${row.product_stock_quantity}.`,
        );
      }
    }

    // ---- 4. Resolve shipping snapshot ----
    const shippingAddress = await resolveShippingAddress(
      client,
      userId,
      checkout,
      {
        full_name: buyer.full_name,
        email: buyer.email,
        phone: buyer.phone,
      },
    );

    // ---- 5. Group items by store_id ----
    const groupsByStore = new Map<string, CartRow[]>();
    for (const row of cartResult.rows) {
      const existing = groupsByStore.get(row.store_id) ?? [];
      existing.push(row);
      groupsByStore.set(row.store_id, existing);
    }

    // ---- 6. payment_group_id ----
    const paymentGroupResult = await client.query<{ id: string }>(
      `SELECT gen_random_uuid()::text AS id`,
    );
    const paymentGroupId = paymentGroupResult.rows[0].id;

    // ---- 7. Buyer snapshot ----
    const [firstName, ...restName] = (buyer.full_name || '').split(' ');
    const customerSnapshot = {
      first_name: firstName ?? '',
      last_name: restName.join(' ') || '',
      email: buyer.email,
      phone: buyer.phone ?? '',
    };

    // ---- 8. Insert orders ----
    const createdOrders: Order[] = [];
    let grandTotal = 0;

    for (const [storeId, items] of groupsByStore) {

      let subtotal = 0;
      const orderItemsJson: OrderItem[] = [];

      for (const row of items) {
        const unitPrice = Number(row.unit_price);
        const lineTotal = unitPrice * row.quantity;
        subtotal += lineTotal;

        orderItemsJson.push({
          id: row.cart_item_id,
          order_id: '',
          product_id: row.product_id,
          variant_id: undefined,
          product_name: row.product_name,
          variant_name: undefined,
          sku: row.product_sku ?? '',
          quantity: row.quantity,
          price: unitPrice,
          total: lineTotal,
          discount_amount: 0,
          tax_amount: 0,
          tax_rate: 0,
          metadata: { image: row.product_image },
          created_at: new Date(),
          updated_at: new Date(),
        });
      }

      const taxTotal = 0;
      const shippingTotal = 0;
      const discountTotal = 0;
      const orderTotal = subtotal + taxTotal + shippingTotal - discountTotal;
      grandTotal += orderTotal;

      const orderNumber = await generateOrderNumber(client);

      const shippingSnapshot: OrderShipping = {
        method: 'standard',
        cost: shippingTotal,
        estimated_days: 5,
        address: shippingAddress,
      };

      const paymentSnapshot: OrderPayment = {
        method: 'mpesa',
        status: 'pending',
        amount: orderTotal,
        currency: DEFAULT_CURRENCY,
      };

      const sellerId = items[0].seller_id;

      const orderResult = await client.query(
        `INSERT INTO orders (
           order_number, store_id, user_id, seller_id,
           customer, items, subtotal, discount_total,
           tax_total, shipping_total, total, currency,
           shipping, payment, status, fulfillment_status,
           payment_status, customer_notes, placed_at,
           created_at, updated_at, payment_group_id
         ) VALUES (
           $1, $2, $3, $4,
           $5::jsonb, $6::jsonb, $7, $8,
           $9, $10, $11, $12,
           $13::jsonb, $14::jsonb, $15, $16,
           $17, $18, NOW(), NOW(), NOW(), $19
         )
         RETURNING *`,
        [
          orderNumber,
          storeId,
          userId,
          sellerId,
          JSON.stringify(customerSnapshot),
          JSON.stringify(orderItemsJson),
          subtotal,
          discountTotal,
          taxTotal,
          shippingTotal,
          orderTotal,
          DEFAULT_CURRENCY,
          JSON.stringify(shippingSnapshot),
          JSON.stringify(paymentSnapshot),
          'pending',
          'unfulfilled',
          'pending',
          checkout.customer_notes ?? null,
          paymentGroupId,
        ],
      );

      const order = mapRowToOrder(orderResult.rows[0]);
      createdOrders.push(order);

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
      }

      for (const item of orderItemsJson) {
        await client.query(
          `UPDATE products
           SET stock_quantity = stock_quantity - $1,
               updated_at = NOW()
           WHERE id = $2`,
          [item.quantity, item.product_id],
        );
      }
    }

    // ---- 9. Clear the cart ----
    await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [
      cartResult.rows[0].cart_id,
    ]);

    await client.query('COMMIT');

    return {
      orders: createdOrders,
      total: grandTotal,
      currency: DEFAULT_CURRENCY,
      payment_group_id: paymentGroupId,
    };
  } catch (error) {
    console.error('[createOrdersFromCart] ❌ error — rolling back:', error);
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

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

    if (role !== 'admin' && role !== 'super_admin' && order.user_id !== userId) {
      throw new AppError(403, 'You do not have permission to update this order.');
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (input.status) {
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
  const order = await getOrderById(orderId);
  if (!order) throw new AppError(404, 'Order not found.');

  if (role !== 'admin' && role !== 'super_admin' && order.user_id !== userId) {
    throw new AppError(403, 'You do not have permission to cancel this order.');
  }
  if (order.status === 'cancelled') {
    throw new AppError(409, 'Order is already cancelled.');
  }
  if (order.status === 'delivered' || order.status === 'completed') {
    throw new AppError(409, 'Order cannot be cancelled after delivery.');
  }

  return updateOrder(
    orderId,
    userId,
    { status: 'cancelled', admin_notes: reason || 'Order cancelled' },
    role || 'user',
  );
};

// ============================================
// PAYMENT GROUP HELPERS
// ============================================

export const markPaymentGroupPaid = async (
  paymentGroupId: string,
  mpesaReceipt: string,
  transactionId: string,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orders = await client.query<{ id: string; payment: OrderPayment }>(
      `SELECT id, payment FROM orders
       WHERE payment_group_id = $1 AND deleted_at IS NULL`,
      [paymentGroupId],
    );

    for (const row of orders.rows) {
      const nextPayment: OrderPayment = {
        ...(row.payment || {}),
        method: 'mpesa',
        status: 'paid',
        transaction_id: transactionId,
        mpesa_receipt: mpesaReceipt,
        paid_at: new Date(),
      } as OrderPayment;

      await client.query(
        `UPDATE orders
         SET payment = $1::jsonb,
             payment_status = 'paid',
             status = CASE WHEN status = 'pending' THEN 'paid' ELSE status END,
             payment_confirmed_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(nextPayment), row.id],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const markPaymentGroupFailed = async (
  paymentGroupId: string,
  reason: string,
): Promise<void> => {
  await pool.query(
    `UPDATE orders
     SET payment_status = 'failed',
         status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END,
         updated_at = NOW()
     WHERE payment_group_id = $1 AND deleted_at IS NULL`,
    [paymentGroupId],
  );
};

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