// src/features/order/order.types.ts

// ============================================
// ENUMS & CONSTANTS
// ============================================

export type OrderStatus =
  | 'pending'         // Order placed, awaiting payment
  | 'payment_pending' // Payment initiated but not confirmed
  | 'paid'            // Payment confirmed
  | 'processing'      // Order being processed
  | 'shipped'         // Order shipped
  | 'delivered'       // Order delivered
  | 'completed'       // Order completed
  | 'cancelled'       // Order cancelled by customer
  | 'refunded'        // Order refunded
  | 'failed';         // Payment failed

export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'partially_refunded';

export type PaymentMethod =
  | 'card'
  | 'mpesa'
  | 'bank_transfer'
  | 'paypal'
  | 'cash_on_delivery'
  | 'store_credit';

export type FulfillmentStatus =
  | 'unfulfilled'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'shipped'
  | 'delivered';

export type ShippingMethod =
  | 'standard'
  | 'express'
  | 'overnight'
  | 'pickup';

// ============================================
// CORE ORDER TYPES
// ============================================

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  variant_id?: string;
  product_name: string;
  variant_name?: string;
  sku: string;
  quantity: number;
  price: number;
  total: number;
  discount_amount: number;
  tax_amount: number;
  tax_rate: number;
  metadata?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface OrderAddress {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company?: string;
  address_line1: string;
  address_line2?: string;
  city: string;
  state?: string;
  postal_code: string;
  country: string;
  instructions?: string;
  /** ✅ NEW: which saved address this snapshot came from, if any. */
  source_address_id?: string;
}

export interface OrderShipping {
  method: ShippingMethod;
  carrier?: string;
  tracking_number?: string;
  tracking_url?: string;
  cost: number;
  estimated_days: number;
  shipped_at?: Date;
  delivered_at?: Date;
  address: OrderAddress;
}

export interface OrderPayment {
  method: PaymentMethod;
  status: PaymentStatus;
  amount: number;
  currency: string;
  transaction_id?: string;
  payment_gateway?: string;
  gateway_response?: Record<string, any>;
  paid_at?: Date;
  refunded_at?: Date;
  refund_amount?: number;
  /** ✅ NEW: the M-Pesa receipt number (e.g. "QK1234ABCD"). */
  mpesa_receipt?: string;
}

export interface Order {
  id: string;
  order_number: string;
  store_id: string;
  user_id: string;
  seller_id: string;

  customer: OrderAddress;
  items: OrderItem[];
  subtotal: number;
  discount_total: number;
  tax_total: number;
  shipping_total: number;
  total: number;
  currency: string;

  shipping: OrderShipping;
  payment: OrderPayment;

  status: OrderStatus;
  fulfillment_status: FulfillmentStatus;
  payment_status: PaymentStatus;

  customer_notes?: string;
  seller_notes?: string;
  admin_notes?: string;

  placed_at: Date;
  payment_confirmed_at?: Date;
  processed_at?: Date;
  shipped_at?: Date;
  delivered_at?: Date;
  completed_at?: Date;
  cancelled_at?: Date;
  refunded_at?: Date;

  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;

  store?: {
    id: string;
    name: string;
    slug: string;
  };
  seller?: {
    id: string;
    legal_business_name: string;
    trading_name?: string;
  };
  user?: {
    id: string;
    full_name: string;
    email: string;
    phone?: string;
  };
}

// ============================================
// ADDRESSES (saved address book)
// ============================================
// ✅ NEW: entity for the `addresses` table.

export interface Address {
  id: string;
  user_id: string;

  label: string | null;
  full_name: string;
  phone: string;

  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  country: string;
  postal_code: string | null;

  is_default: boolean;

  created_at: Date;
  updated_at: Date;
}

export interface CreateAddressInput {
  label?: string | null;
  full_name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  country?: string;
  postal_code?: string | null;
  is_default?: boolean;
}

export interface UpdateAddressInput extends Partial<CreateAddressInput> {}

// ============================================
// M-PESA TRANSACTIONS
// ============================================
// ✅ NEW: mirrors the `mpesa_transactions` table.

export type MpesaTransactionStatus =
  | 'initiated'
  | 'pending'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface MpesaTransaction {
  id: string;
  order_id: string;

  merchant_request_id: string | null;
  checkout_request_id: string | null;
  mpesa_receipt: string | null;

  phone: string;
  amount: number;

  status: MpesaTransactionStatus;
  result_code: string | null;
  result_desc: string | null;

  request_payload: Record<string, unknown> | null;
  callback_payload: Record<string, unknown> | null;

  initiated_at: Date;
  completed_at: Date | null;

  created_at: Date;
  updated_at: Date;
}

// ============================================
// REQUEST TYPES
// ============================================

export interface CreateOrderInput {
  store_id: string;
  items: {
    product_id: string;
    variant_id?: string;
    quantity: number;
  }[];
  shipping: {
    method: ShippingMethod;
    address: OrderAddress;
  };
  payment: {
    method: PaymentMethod;
  };
  customer_notes?: string;
  currency?: string;
}

export interface UpdateOrderInput {
  status?: OrderStatus;
  fulfillment_status?: FulfillmentStatus;
  payment_status?: PaymentStatus;
  shipping_tracking?: {
    carrier: string;
    tracking_number: string;
    tracking_url?: string;
  };
  customer_notes?: string;
  seller_notes?: string;
  admin_notes?: string;
}

export interface UpdateOrderStatusInput {
  status: OrderStatus;
  reason?: string;
  notes?: string;
}

/**
 * ✅ NEW: body of POST /checkout. Converts the buyer's cart into an order.
 * Either `address_id` (a saved address) OR `shipping_address` (one-off) must
 * be provided, but not both.
 */
export interface CheckoutInput {
  address_id?: string;
  shipping_address?: CreateAddressInput;
  customer_notes?: string;
}

/**
 * ✅ NEW: body of POST /payments/mpesa/initiate.
 * If `phone` is omitted, the order's shipping phone is used.
 */
export interface InitiateMpesaPaymentInput {
  order_id: string;
  /**
   * Phone in E.164 without the plus sign: `254712345678`.
   * Daraja rejects `+254...` and spaces.
   */
  phone?: string;
}

// ============================================
// RESPONSE TYPES
// ============================================

export interface OrderResponse {
  success: boolean;
  message: string;
  data: Order;
}

export interface OrdersListResponse {
  success: boolean;
  data: Order[];
  summary: {
    total: number;
    total_revenue: number;
    status_breakdown: Record<OrderStatus, number>;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface OrderMetrics {
  order_id: string;
  period: 'today' | 'week' | 'month' | 'year' | 'all';
  total_orders: number;
  total_revenue: number;
  average_order_value: number;
  conversion_rate: number;
  cancelled_rate: number;
  return_rate: number;
}

export interface AddressResponse {
  success: boolean;
  message?: string;
  data: { address: Address };
}

export interface AddressesListResponse {
  success: boolean;
  data: Address[];
}

export interface MpesaInitResponse {
  success: boolean;
  message: string;
  data: {
    order_id: string;
    transaction_id: string;
    checkout_request_id: string;
    merchant_request_id: string;
    customer_message: string;
  };
}

export interface MpesaStatusResponse {
  success: boolean;
  data: {
    status: MpesaTransactionStatus;
    order_status: OrderStatus;
    order_payment_status: PaymentStatus;
    mpesa_receipt: string | null;
    result_code: string | null;
    result_desc: string | null;
  };
}

// ============================================
// QUERY TYPES
// ============================================

export interface GetOrdersQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: OrderStatus[];
  payment_status?: PaymentStatus;
  fulfillment_status?: FulfillmentStatus;
  store_id?: string;
  seller_id?: string;
  user_id?: string;
  min_total?: number;
  max_total?: number;
  date_from?: Date;
  date_to?: Date;
  sortBy?: 'created_at' | 'total' | 'status';
  sortOrder?: 'asc' | 'desc';
}

// ============================================
// ORDER STATUS TRANSITIONS
// ============================================

export const OrderStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
  'pending': ['payment_pending', 'cancelled'],
  'payment_pending': ['paid', 'failed', 'cancelled'],
  'paid': ['processing', 'cancelled', 'refunded'],
  'processing': ['shipped', 'cancelled'],
  'shipped': ['delivered', 'cancelled'],
  'delivered': ['completed'],
  'completed': [],
  'cancelled': ['refunded'],
  'refunded': [],
  'failed': ['payment_pending', 'cancelled'],
};

export const isStatusTransitionValid = (
  current: OrderStatus,
  next: OrderStatus,
): boolean => {
  return OrderStatusTransitions[current]?.includes(next) || false;
};