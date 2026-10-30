// src/validators/order.validator.ts

import { z } from 'zod';

// ============================================
// ENUM VALIDATORS
// ============================================

const OrderStatusEnum = z.enum([
  'pending', 'payment_pending', 'paid', 'processing',
  'shipped', 'delivered', 'completed', 'cancelled',
  'refunded', 'failed',
]);

const PaymentStatusEnum = z.enum([
  'pending', 'processing', 'paid', 'failed',
  'refunded', 'partially_refunded',
]);

const PaymentMethodEnum = z.enum([
  'card', 'mpesa', 'bank_transfer', 'paypal',
  'cash_on_delivery', 'store_credit',
]);

const FulfillmentStatusEnum = z.enum([
  'unfulfilled', 'partially_fulfilled', 'fulfilled',
  'shipped', 'delivered',
]);

const ShippingMethodEnum = z.enum([
  'standard', 'express', 'overnight', 'pickup',
]);

// ============================================
// SHARED FIELDS
// ============================================

const uuidSchema = z.string().uuid('Invalid UUID format');

// ============================================
// ADDRESS SCHEMAS
// ============================================

/** Body shape for creating or updating an address. */
export const addressBodySchema = z.object({
  label: z.string().max(50).optional().nullable(),
  first_name: z.string().min(1, 'First name is required').max(100).trim(),
  last_name: z.string().min(1, 'Last name is required').max(100).trim(),
  email: z.string().email('Invalid email').max(254),
  phone: z.string().min(10, 'Phone number is required').max(20),
  company: z.string().max(100).optional().nullable(),
  address_line1: z.string().min(1, 'Address is required').max(255),
  address_line2: z.string().max(255).optional().nullable(),
  city: z.string().min(1, 'City is required').max(100),
  state: z.string().max(100).optional().nullable(),
  postal_code: z.string().min(1, 'Postal code is required').max(20),
  country: z.string().length(2, 'Country must be a 2-letter ISO code')
    .toUpperCase(),
  instructions: z.string().max(500).optional().nullable(),
  is_default: z.boolean().optional(),
});

export type AddressBody = z.infer<typeof addressBodySchema>;

/** POST /addresses */
export const createAddressSchema = z.object({
  body: addressBodySchema,
});

/** PATCH /addresses/:addressId */
export const updateAddressSchema = z.object({
  params: z.object({ addressId: uuidSchema }),
  body: addressBodySchema.partial().refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one field must be provided' },
  ),
});

/** DELETE /addresses/:addressId  ·  PATCH /addresses/:addressId/default */
export const addressIdParamSchema = z.object({
  params: z.object({ addressId: uuidSchema }),
});

// ============================================
// CHECKOUT SCHEMA
// ============================================
// POST /checkout — converts the buyer's cart into an order.
//
// At least one of `address_id` (saved address) or `shipping_address`
// (inline) must be provided. Either alone is valid.
//
// Wrapped in `body` to match the validate() middleware, which parses
// `{ body, query, params }` — same shape as the other schemas in this file.

export const checkoutSchema = z.object({
  body: z
    .object({
      address_id: uuidSchema.optional(),
      shipping_address: addressBodySchema
        .omit({ is_default: true })
        .optional(),
      customer_notes: z.string().max(1000).optional().nullable(),
      coupon_code: z.string().max(50).optional().nullable(),
      pickup_station_id: uuidSchema.optional().nullable(),
    })
    .refine(
      (data) => Boolean(data.address_id) || Boolean(data.shipping_address) || Boolean(data.pickup_station_id),
      {
        message:
          'Provide address_id (saved address), shipping_address (inline) or pickup_station_id.',
        path: ['address_id'],
      },
    ),
});

export type CheckoutBody = z.infer<typeof checkoutSchema>['body'];

// ============================================
// CREATE ORDER SCHEMA (admin / manual use)
// ============================================
// Kept for admin-initiated order creation. Buyers go through /checkout.

export const createOrderSchema = z.object({
  body: z.object({
    store_id: uuidSchema,
    items: z
      .array(
        z.object({
          product_id: uuidSchema,
          variant_id: uuidSchema.optional(),
          quantity: z.number().int().min(1, 'Quantity must be at least 1'),
        }),
      )
      .min(1, 'At least one item is required'),
    shipping: z.object({
      method: ShippingMethodEnum,
      address: addressBodySchema,
    }),
    payment: z.object({
      method: PaymentMethodEnum,
    }),
    customer_notes: z.string().max(1000).optional(),
    currency: z.string().length(3).default('KES'),
  }),
});

// ============================================
// ORDER METRICS SCHEMA
// ============================================

/**
 * GET /orders/:orderId/metrics?period=month
 */
export const orderMetricsSchema = z.object({
  params: z.object({
    orderId: uuidSchema,
  }),
  query: z.object({
    period: z
      .enum(['today', 'week', 'month', 'year', 'all'])
      .optional()
      .default('month'),
  }),
});

// ============================================
// UPDATE ORDER SCHEMA
// ============================================

export const updateOrderSchema = z.object({
  params: z.object({ orderId: uuidSchema }),
  body: z.object({
    status: OrderStatusEnum.optional(),
    fulfillment_status: FulfillmentStatusEnum.optional(),
    payment_status: PaymentStatusEnum.optional(),
    shipping_tracking: z
      .object({
        carrier: z.string().max(100),
        tracking_number: z.string().max(100),
        tracking_url: z.string().url().optional(),
      })
      .optional(),
    customer_notes: z.string().max(1000).optional(),
    seller_notes: z.string().max(1000).optional(),
    admin_notes: z.string().max(1000).optional(),
  }),
});

// ============================================
// UPDATE ORDER STATUS SCHEMA
// ============================================

export const updateOrderStatusSchema = z.object({
  params: z.object({ orderId: uuidSchema }),
  body: z.object({
    status: OrderStatusEnum,
    reason: z.string().max(500).optional(),
    notes: z.string().max(500).optional(),
  }),
});

// ============================================
// GET ORDERS QUERY SCHEMA
// ============================================

/**
 * Express delivers `?status=paid` as a string and `?status=paid&status=shipped`
 * as a string[]. Normalize both into an array.
 */
const statusArraySchema = z
  .union([OrderStatusEnum, z.array(OrderStatusEnum)])
  .optional()
  .transform((val) =>
    val === undefined ? undefined : Array.isArray(val) ? val : [val],
  );

export const getOrdersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().min(1).optional().default(1),
    limit: z.coerce.number().min(1).max(100).optional().default(20),
    search: z.string().max(100).optional(),
    status: statusArraySchema,
    payment_status: PaymentStatusEnum.optional(),
    fulfillment_status: FulfillmentStatusEnum.optional(),
    store_id: uuidSchema.optional(),
    seller_id: uuidSchema.optional(),
    user_id: uuidSchema.optional(),
    min_total: z.coerce.number().min(0).optional(),
    max_total: z.coerce.number().min(0).optional(),
    date_from: z
      .string()
      .datetime()
      .optional()
      .transform((v) => (v ? new Date(v) : undefined)),
    date_to: z
      .string()
      .datetime()
      .optional()
      .transform((v) => (v ? new Date(v) : undefined)),
    sortBy: z
      .enum(['created_at', 'total', 'status'])
      .optional()
      .default('created_at'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

// ============================================
// ORDER ID PARAM SCHEMA
// ============================================

/** GET /orders/:orderId  ·  GET /orders/:orderId/timeline */
export const orderIdParamSchema = z.object({
  params: z.object({ orderId: uuidSchema }),
});

// ============================================
// M-PESA PAYMENT SCHEMAS
// ============================================

/**
 * POST /payments/mpesa/initiate
 *
 * `phone` must be E.164 WITHOUT the plus sign — Daraja rejects `+254...`
 * and any spaces. The regex enforces `254XXXXXXXXX` (12 digits, starting 254).
 */
export const mpesaInitSchema = z.object({
  body: z.object({
    order_id: uuidSchema,
    phone: z
      .string()
      .regex(
        /^254\d{9}$/,
        'Phone must be in format 254XXXXXXXXX (12 digits, no plus sign)',
      )
      .optional(),
  }),
});

export type MpesaInitBody = z.infer<typeof mpesaInitSchema>['body'];

/**
 * GET /payments/mpesa/status/:orderId
 */
export const mpesaStatusParamSchema = z.object({
  params: z.object({ orderId: uuidSchema }),
});

/**
 * Daraja callback payload — Safaricom POSTs this to us after STK push.
 * We accept anything (`passthrough`) because Safaricom's schema is not
 * stable and it changes between sandbox and production. We validate the
 * fields we actually need on the handler side.
 */
export const mpesaCallbackSchema = z
  .object({
    Body: z
      .object({
        stkCallback: z
          .object({
            MerchantRequestID: z.string(),
            CheckoutRequestID: z.string(),
            ResultCode: z.number(),
            ResultDesc: z.string(),
            CallbackMetadata: z
              .object({
                Item: z.array(
                  z.object({
                    Name: z.string(),
                    Value: z.union([z.string(), z.number()]).optional(),
                  }),
                ),
              })
              .optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

// ============================================
// EXPORTS — infered types for services
// ============================================

export type GetOrdersQueryInput = z.infer<
  typeof getOrdersQuerySchema
>['query'];

export type UpdateOrderBody = z.infer<typeof updateOrderSchema>['body'];
export type UpdateOrderStatusBody = z.infer<
  typeof updateOrderStatusSchema
>['body'];