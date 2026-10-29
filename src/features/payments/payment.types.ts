// src/features/payment/payment.types.ts

import type { UUID } from '../catalog/common.types';
import type {
  OrderStatus,
  PaymentStatus,
  MpesaTransactionStatus,
} from '../orders/order.types';

// ============================================
// INPUTS — request bodies
// ============================================

/**
 * POST /payments/mpesa/initiate
 *
 * Initiates an STK push for an entire payment group (one or more orders
 * created by a single checkout). The server sums the group's totals and
 * sends one prompt to the customer's phone.
 */
export interface InitiateMpesaInput {
  /** The payment group returned by POST /checkout. */
  payment_group_id: UUID;

  /**
   * Phone to bill. Optional — if omitted, the server uses the phone from
   * the order's shipping snapshot.
   *
   * Accepted formats (all normalized server-side to 254XXXXXXXXX):
   *   - 0712345678
   *   - +254712345678
   *   - 254712345678
   */
  phone?: string;
}

/**
 * POST /payments/mpesa/callback
 *
 * The request body from Safaricom. We don't validate it strictly — the
 * schema is unstable across environments — but we model the fields we
 * actually read.
 */
export interface MpesaCallbackItem {
  Name: string;
  Value?: string | number;
}

export interface MpesaCallbackStkCallback {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResultCode?: number;
  ResultDesc?: string;
  CallbackMetadata?: {
    Item?: MpesaCallbackItem[];
  };
}

export interface MpesaCallbackBody {
  Body?: {
    stkCallback?: MpesaCallbackStkCallback;
  };
}

// ============================================
// RESPONSES — what we send back to the client
// ============================================

/**
 * POST /payments/mpesa/initiate — success response.
 * The client should:
 *   1. Show "check your phone" UI
 *   2. Poll GET /payments/mpesa/status/:paymentGroupId every 2–3s
 */
export interface InitiateMpesaResponse {
  success: boolean;
  message: string;
  data: {
    payment_group_id: UUID;
    transaction_id: UUID;
    merchant_request_id: string;
    checkout_request_id: string;
    customer_message: string;
  };
}

/**
 * GET /payments/mpesa/status/:paymentGroupId — polling response.
 * The client keeps polling until `status` is no longer `pending`.
 */
export interface PaymentStatusResponse {
  success: boolean;
  data: {
    status: MpesaTransactionStatus;
    mpesa_receipt: string | null;
    result_desc: string | null;
    orders_paid: number;
    orders_total: number;

    /**
     * Convenience: the primary order status once payment succeeds.
     * Null when the payment is still pending or failed.
     */
    order_status: OrderStatus | null;
    order_payment_status: PaymentStatus | null;
  };
}

/**
 * POST /payments/mpesa/callback — the HTTP response Safaricom expects.
 *
 * Safaricom only inspects the HTTP status code — 200 means "received,
 * don't retry". The body content is ignored, but we return a standard
 * acknowledgement shape.
 */
export interface MpesaCallbackAck {
  ResultCode: 0;
  ResultDesc: string;
}