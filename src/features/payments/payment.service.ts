// src/features/payments/payment.service.ts

import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import {
  initiatePayment,
  getPaymentGroupStatus,
  type PaymentGroupStatus,
} from '../mpesaservice/mpesa.service';
import type {
  InitiateMpesaInput,
  InitiateMpesaResponse,
  PaymentStatusResponse,
} from './payment.types';
import type { OrderStatus, PaymentStatus } from '../orders/order.types';

// ============================================
// INITIATE — POST /payments/mpesa/initiate
// ============================================

/**
 * Initiate an STK push for a payment group.
 *
 * Resolves the phone to bill:
 *   1. If the client sent one, use it.
 *   2. Otherwise fall back to the phone on the shipping snapshot of any
 *      order in the group.
 *
 * Then delegates to mpesa.service.initiatePayment, which talks to Daraja.
 */
export const initiateMpesaPayment = async (
  input: InitiateMpesaInput,
): Promise<InitiateMpesaResponse> => {
  const { payment_group_id, phone } = input;

  let phoneToBill = phone;

  if (!phoneToBill) {
    const fallback = await pool.query<{ phone: string | null }>(
      `SELECT shipping->'address'->>'phone' AS phone
       FROM orders
       WHERE payment_group_id = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [payment_group_id],
    );

    if (fallback.rows.length === 0) {
      throw new AppError(404, 'Order group not found.');
    }

    phoneToBill = fallback.rows[0].phone ?? undefined;
    if (!phoneToBill) {
      throw new AppError(
        400,
        'No phone number on file. Provide a phone to bill.',
      );
    }
  }

  const result = await initiatePayment(payment_group_id, phoneToBill);

  return {
    success: true,
    message: 'STK push sent. Ask the customer to enter their M-Pesa PIN.',
    data: {
      payment_group_id,
      transaction_id: result.transaction_id,
      merchant_request_id: result.merchant_request_id,
      checkout_request_id: result.checkout_request_id,
      customer_message: result.customer_message,
    },
  };
};

// ============================================
// STATUS — GET /payments/mpesa/status/:paymentGroupId
// ============================================

/**
 * Return the polling status for a payment group, enriched with the
 * primary order's status so the mobile UI can flip from "waiting for
 * PIN" straight to "paid / failed" without a second request.
 */
export const getPaymentStatus = async (
  paymentGroupId: string,
): Promise<PaymentStatusResponse> => {
  const status: PaymentGroupStatus = await getPaymentGroupStatus(
    paymentGroupId,
  );

  // Pull the primary order's status fields. "Primary" here means any
  // order in the group — they all share the same status once payment
  // resolves, so ordering doesn't matter for the convenience fields.
  const orderResult = await pool.query<{
    status: OrderStatus;
    payment_status: PaymentStatus;
  }>(
    `SELECT status, payment_status
     FROM orders
     WHERE payment_group_id = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [paymentGroupId],
  );

  const orderRow = orderResult.rows[0] ?? null;

  return {
    success: true,
    data: {
      status: status.status,
      mpesa_receipt: status.mpesa_receipt,
      result_desc: status.result_desc,
      orders_paid: status.orders_paid,
      orders_total: status.orders_total,
      order_status: orderRow?.status ?? null,
      order_payment_status: orderRow?.payment_status ?? null,
    },
  };
};