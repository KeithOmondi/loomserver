// src/features/mpesaservice/mpesa.service.ts

import axios from 'axios';
import { pool } from '../../config/db';
import { redisService } from '../../config/redis';
import { env } from '../../config/env';
import { AppError } from '../../utils/response';
import {
  markPaymentGroupPaid,
  markPaymentGroupFailed,
} from '../orders/order.service';

// ============================================
// CONFIG — read from the validated env object
// ============================================

const BASE_URL = env.mpesa.isSandbox
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

const CONSUMER_KEY = env.mpesa.consumerKey;
const CONSUMER_SECRET = env.mpesa.consumerSecret;
const SHORTCODE = env.mpesa.shortcode;
const PASSKEY = env.mpesa.passkey;
const CALLBACK_URL = env.mpesa.callbackUrl;
const CALLBACK_IPS = env.mpesa.callbackIps;

// The env schema already enforces these are present at boot, so no runtime
// check is needed. If they were missing, the process would have exited.

// ============================================
// AUTH — OAuth token, cached in Redis
// ============================================

const TOKEN_CACHE_KEY = 'mpesa:oauth:token';
const TOKEN_TTL_SECONDS = 3300; // 55 minutes (Safaricom expires at 60)

const getAccessToken = async (): Promise<string> => {
  const cached = await redisService.cacheGet<string>(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const credentials = Buffer.from(
    `${CONSUMER_KEY}:${CONSUMER_SECRET}`,
  ).toString('base64');

  try {
    const { data } = await axios.get<{ access_token: string }>(
      `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${credentials}` },
        timeout: 10_000,
      },
    );

    await redisService.cacheSet(
      TOKEN_CACHE_KEY,
      data.access_token,
      TOKEN_TTL_SECONDS,
    );

    return data.access_token;
  } catch (err) {
    console.error('[mpesa] OAuth failed:', (err as Error).message);
    throw new AppError(502, 'Could not authenticate with M-Pesa.');
  }
};

// ============================================
// HELPERS
// ============================================

/**
 * Timestamp in Daraja format: YYYYMMDDHHmmss (East Africa Time).
 */
const darajaTimestamp = (): string => {
  const now = new Date();
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    eat.getUTCFullYear().toString() +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  );
};

/**
 * Normalize a phone number to Daraja's required format: 254XXXXXXXXX.
 * Accepts +254..., 0..., 254..., or with spaces.
 */
export const normalizePhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
};

const validatePhone = (phone: string): void => {
  if (!/^254\d{9}$/.test(phone)) {
    throw new AppError(
      400,
      'Phone must be a valid Kenyan number (e.g. 254712345678).',
    );
  }
};

/**
 * Optional source-IP check for callbacks. If CALLBACK_IPS is empty
 * (dev), this returns true for any IP.
 */
export const isTrustedCallbackIp = (ip: string): boolean => {
  if (CALLBACK_IPS.length === 0) return true;
  const normalized = ip.replace(/^::ffff:/, ''); // strip IPv6-mapped prefix
  return CALLBACK_IPS.includes(normalized);
};

// ============================================
// STK PUSH — INITIATE PAYMENT
// ============================================

export interface InitiateResult {
  merchant_request_id: string;
  checkout_request_id: string;
  customer_message: string;
  transaction_id: string;
}

export const initiatePayment = async (
  paymentGroupId: string,
  phone: string,
): Promise<InitiateResult> => {
  const normalized = normalizePhone(phone);
  validatePhone(normalized);

  // 1. Load all unpaid orders in the group
  const ordersResult = await pool.query<{
    id: string;
    total: string;
    payment_status: string;
  }>(
    `SELECT id, total, payment_status
     FROM orders
     WHERE payment_group_id = $1 AND deleted_at IS NULL`,
    [paymentGroupId],
  );

  if (ordersResult.rows.length === 0) {
    throw new AppError(404, 'Order group not found.');
  }

  const unpaid = ordersResult.rows.filter(
    (o) => o.payment_status !== 'paid',
  );
  if (unpaid.length === 0) {
    throw new AppError(409, 'This order group is already paid.');
  }

  // 2. Compute total
  const amount = unpaid.reduce((sum, o) => sum + Number(o.total), 0);
  const amountInt = Math.ceil(amount); // Daraja requires an integer

  // 3. Create the transaction row (status 'initiated')
  const txResult = await pool.query<{ id: string }>(
    `INSERT INTO mpesa_transactions (
       order_id, phone, amount, status, initiated_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'initiated', NOW(), NOW(), NOW())
     RETURNING id`,
    [unpaid[0].id, normalized, amount],
  );
  const transactionId = txResult.rows[0].id;

  // 4. Build Daraja request
  const timestamp = darajaTimestamp();
  const password = Buffer.from(
    `${SHORTCODE}${PASSKEY}${timestamp}`,
  ).toString('base64');

  const payload = {
    BusinessShortCode: SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amountInt,
    PartyA: normalized,
    PartyB: SHORTCODE,
    PhoneNumber: normalized,
    CallBackURL: CALLBACK_URL,
    AccountReference: paymentGroupId.slice(0, 12),
    TransactionDesc: 'Marketplace order payment',
  };

  // 5. Call Daraja
  const token = await getAccessToken();

  let darajaResponse: any;
  try {
    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    );
    darajaResponse = data;
  } catch (err) {
    const msg =
      (err as any)?.response?.data?.errorMessage ??
      (err as Error).message;

    await pool.query(
      `UPDATE mpesa_transactions
       SET status = 'failed',
           result_desc = $1,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [msg, transactionId],
    );

    console.error('[mpesa] STK push failed:', msg);
    throw new AppError(502, `M-Pesa request failed: ${msg}`);
  }

  // 6. Persist Daraja's identifiers
  const merchantRequestId = darajaResponse.MerchantRequestID;
  const checkoutRequestId = darajaResponse.CheckoutRequestID;

  if (!checkoutRequestId) {
    await pool.query(
      `UPDATE mpesa_transactions
       SET status = 'failed',
           result_desc = $1,
           request_payload = $2::jsonb,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $3`,
      ['Missing CheckoutRequestID', JSON.stringify(darajaResponse), transactionId],
    );
    throw new AppError(502, 'M-Pesa did not return a checkout request id.');
  }

  await pool.query(
    `UPDATE mpesa_transactions
     SET status = 'pending',
         merchant_request_id = $1,
         checkout_request_id = $2,
         request_payload = $3::jsonb,
         updated_at = NOW()
     WHERE id = $4`,
    [
      merchantRequestId ?? null,
      checkoutRequestId,
      JSON.stringify(payload),
      transactionId,
    ],
  );

  // 7. Mark orders as 'initiated' so the UI can show "waiting for PIN"
  await pool.query(
    `UPDATE orders
     SET payment_status = 'initiated',
         status = CASE WHEN status = 'pending' THEN 'payment_pending' ELSE status END,
         updated_at = NOW()
     WHERE payment_group_id = $1 AND payment_status <> 'paid'`,
    [paymentGroupId],
  );

  return {
    merchant_request_id: merchantRequestId ?? '',
    checkout_request_id: checkoutRequestId,
    customer_message:
      darajaResponse.CustomerMessage ??
      'Check your phone and enter your M-Pesa PIN.',
    transaction_id: transactionId,
  };
};

// ============================================
// CALLBACK — SAFARICOM POSTS THE RESULT HERE
// ============================================

interface CallbackItem {
  Name: string;
  Value?: string | number;
}

export interface CallbackPayload {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: { Item?: CallbackItem[] };
    };
  };
}

export const handleCallback = async (
  payload: CallbackPayload,
): Promise<void> => {
  const stk = payload?.Body?.stkCallback;

  if (!stk?.CheckoutRequestID) {
    console.warn('[mpesa] Callback missing CheckoutRequestID');
    return;
  }

  const checkoutRequestId = stk.CheckoutRequestID;
  const resultCode = stk.ResultCode ?? -1;
  const resultDesc = stk.ResultDesc ?? 'Unknown';

  // 1. Find the transaction
  const txResult = await pool.query<{
    id: string;
    order_id: string;
    status: string;
    payment_group_id: string | null;
  }>(
    `SELECT mt.id, mt.order_id, mt.status, o.payment_group_id
     FROM mpesa_transactions mt
     JOIN orders o ON o.id = mt.order_id
     WHERE mt.checkout_request_id = $1
     LIMIT 1`,
    [checkoutRequestId],
  );

  if (txResult.rows.length === 0) {
    console.warn(
      `[mpesa] Callback for unknown CheckoutRequestID: ${checkoutRequestId}`,
    );
    return;
  }

  const tx = txResult.rows[0];

  // 2. Idempotency — ignore if already terminal
  if (
    tx.status === 'success' ||
    tx.status === 'failed' ||
    tx.status === 'cancelled'
  ) {
    // The status query may have confirmed the payment before the callback arrived. When the
    // callback does arrive, keep its receipt number for reconciliation.
    if (resultCode === 0) {
      const late = stk.CallbackMetadata?.Item?.find((i) => i.Name === 'MpesaReceiptNumber');
      if (late?.Value) await attachReceipt(tx.id, tx.payment_group_id, String(late.Value), payload);
    }
    console.log(
      `[mpesa] Duplicate callback for ${checkoutRequestId} (already ${tx.status}) — ignoring`,
    );
    return;
  }

  // 3. Extract the receipt number on success
  let receipt: string | null = null;
  if (resultCode === 0 && stk.CallbackMetadata?.Item) {
    const item = stk.CallbackMetadata.Item.find(
      (i) => i.Name === 'MpesaReceiptNumber',
    );
    if (item?.Value) receipt = String(item.Value);
  }

  // 4. Persist the callback
  await pool.query(
    `UPDATE mpesa_transactions
     SET status = $1,
         result_code = $2,
         result_desc = $3,
         mpesa_receipt = $4,
         callback_payload = $5::jsonb,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $6`,
    [
      resultCode === 0 ? 'success' : 'failed',
      String(resultCode),
      resultDesc,
      receipt,
      JSON.stringify(payload),
      tx.id,
    ],
  );

  // 5. Update the order(s)
  if (resultCode === 0 && receipt && tx.payment_group_id) {
    await markPaymentGroupPaid(tx.payment_group_id, receipt, tx.id);
  } else if (tx.payment_group_id) {
    await markPaymentGroupFailed(tx.payment_group_id, resultDesc);
  }
};

const attachReceipt = async (txId: string, groupId: string | null, receipt: string, payload: unknown): Promise<void> => {
  const upd = await pool.query(
    `UPDATE mpesa_transactions SET mpesa_receipt = $1, callback_payload = $2::jsonb, updated_at = NOW()
     WHERE id = $3 AND mpesa_receipt IS NULL RETURNING id`,
    [receipt, JSON.stringify(payload), txId],
  );
  if (upd.rows.length && groupId) {
    await pool.query(
      `UPDATE orders SET payment = jsonb_set(COALESCE(payment, '{}'::jsonb), '{mpesa_receipt}', to_jsonb($1::text)) WHERE payment_group_id = $2`,
      [receipt, groupId],
    );
  }
};

// ============================================
// STK QUERY — confirm a payment without waiting for the callback
// ============================================
// Safaricom's callback can be missed (tunnel down, firewall, outage). Asking Safaricom directly
// makes payment confirmation reliable: the status screen and a background sweep both use this.

export interface StkQueryResult {
  state: 'success' | 'cancelled' | 'timeout' | 'failed' | 'pending';
  code: string | null;
  desc: string;
}

const STILL_PROCESSING = /being processed|still processing|processing/i;
const lastQueryAt = new Map<string, number>();
const QUERY_GAP_MS = 5_000;

export const queryStkStatus = async (checkoutRequestId: string): Promise<StkQueryResult> => {
  const timestamp = darajaTimestamp();
  const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
  const token = await getAccessToken();

  try {
    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      { BusinessShortCode: SHORTCODE, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15_000 },
    );
    const code = data?.ResultCode !== undefined && data?.ResultCode !== null ? String(data.ResultCode) : null;
    const desc = String(data?.ResultDesc ?? '');
    if (code === null) return { state: 'pending', code, desc };
    if (code === '0') return { state: 'success', code, desc };
    if (code === '1032') return { state: 'cancelled', code, desc: desc || 'Request cancelled by user' };
    if (code === '1037') return { state: 'timeout', code, desc: desc || 'No response from the phone' };
    return { state: 'failed', code, desc: desc || 'Payment failed' };
  } catch (err) {
    const body = (err as any)?.response?.data;
    const msg = String(body?.errorMessage ?? body?.ResultDesc ?? (err as Error).message ?? '');
    // "The transaction is being processed" (or any lookup hiccup) means: not decided yet.
    // A failed lookup must never fail a payment, so everything uncertain stays pending.
    return { state: 'pending', code: null, desc: STILL_PROCESSING.test(msg) ? 'Still processing' : msg };
  }
};

/** Settles a pending payment group by asking Safaricom. Safe to call repeatedly and alongside the callback. */
export const reconcilePaymentGroup = async (paymentGroupId: string): Promise<'success' | 'failed' | 'pending'> => {
  const row = (
    await pool.query<{ id: string; checkout_request_id: string }>(
      `SELECT mt.id, mt.checkout_request_id
       FROM mpesa_transactions mt JOIN orders o ON o.id = mt.order_id
       WHERE o.payment_group_id = $1 AND mt.status = 'pending' AND mt.checkout_request_id IS NOT NULL
       ORDER BY mt.created_at DESC LIMIT 1`,
      [paymentGroupId],
    )
  ).rows[0];
  if (!row) return 'pending';

  const last = lastQueryAt.get(row.id) ?? 0;
  if (Date.now() - last < QUERY_GAP_MS) return 'pending';
  lastQueryAt.set(row.id, Date.now());

  const result = await queryStkStatus(row.checkout_request_id);
  if (result.state === 'pending') return 'pending';

  // Only one of {callback, this query} may settle the transaction.
  const won = await pool.query(
    `UPDATE mpesa_transactions
     SET status = $1, result_code = $2, result_desc = $3, completed_at = NOW(), updated_at = NOW()
     WHERE id = $4 AND status = 'pending' RETURNING id`,
    [result.state, result.code, result.desc, row.id],
  );
  if (!won.rows.length) return result.state === 'success' ? 'success' : 'failed';

  if (result.state === 'success') {
    await markPaymentGroupPaid(paymentGroupId, null, row.id);
    return 'success';
  }
  await markPaymentGroupFailed(paymentGroupId, result.desc);
  return 'failed';
};

/** Worker sweep: settle payments whose customer closed the page or whose callback never arrived. */
export const reconcileStalePayments = async (): Promise<number> => {
  const groups = await pool.query<{ payment_group_id: string }>(
    `SELECT DISTINCT o.payment_group_id
     FROM mpesa_transactions mt JOIN orders o ON o.id = mt.order_id
     WHERE mt.status = 'pending' AND mt.checkout_request_id IS NOT NULL AND o.payment_group_id IS NOT NULL
       AND mt.initiated_at < NOW() - INTERVAL '45 seconds' AND mt.initiated_at > NOW() - INTERVAL '3 hours'
     LIMIT 30`,
  );
  let settled = 0;
  for (const g of groups.rows) {
    try {
      if ((await reconcilePaymentGroup(g.payment_group_id)) !== 'pending') settled += 1;
    } catch (err) {
      console.error('[mpesa] reconcile failed for', g.payment_group_id, (err as Error).message);
    }
  }
  return settled;
};

// ============================================
// STATUS QUERY — for the mobile polling screen
// ============================================

export interface PaymentGroupStatus {
  status: 'pending' | 'success' | 'failed' | 'cancelled' | 'timeout';
  mpesa_receipt: string | null;
  result_desc: string | null;
  orders_paid: number;
  orders_total: number;
}

export const getPaymentGroupStatus = async (
  paymentGroupId: string,
): Promise<PaymentGroupStatus> => {
  // Don't depend on the callback alone: if it hasn't arrived, ask Safaricom (throttled).
  try {
    await reconcilePaymentGroup(paymentGroupId);
  } catch (err) {
    console.error('[mpesa] status reconcile failed:', (err as Error).message);
  }

  const txResult = await pool.query<{
    status: string;
    mpesa_receipt: string | null;
    result_desc: string | null;
  }>(
    `SELECT mt.status, mt.mpesa_receipt, mt.result_desc
     FROM mpesa_transactions mt
     JOIN orders o ON o.id = mt.order_id
     WHERE o.payment_group_id = $1
     ORDER BY mt.created_at DESC
     LIMIT 1`,
    [paymentGroupId],
  );

  const ordersResult = await pool.query<{
    total: number;
    paid: number;
  }>(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid
     FROM orders
     WHERE payment_group_id = $1 AND deleted_at IS NULL`,
    [paymentGroupId],
  );

  const ordersTotal = ordersResult.rows[0]?.total ?? 0;
  const ordersPaid = ordersResult.rows[0]?.paid ?? 0;

  if (txResult.rows.length === 0) {
    return {
      status: 'pending',
      mpesa_receipt: null,
      result_desc: null,
      orders_paid: ordersPaid,
      orders_total: ordersTotal,
    };
  }

  const row = txResult.rows[0];

  let status: PaymentGroupStatus['status'];
  switch (row.status) {
    case 'success':
      status = 'success';
      break;
    case 'failed':
      status = 'failed';
      break;
    case 'cancelled':
      status = 'cancelled';
      break;
    case 'timeout':
      status = 'timeout';
      break;
    default:
      status = 'pending';
  }

  return {
    status,
    mpesa_receipt: row.mpesa_receipt,
    result_desc: row.result_desc,
    orders_paid: ordersPaid,
    orders_total: ordersTotal,
  };
};