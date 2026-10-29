// src/features/payments/payment.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { AppError } from '../../utils/response';
import {
  initiateMpesaPayment,
  getPaymentStatus,
} from './payment.service';
import {
  handleCallback,
  isTrustedCallbackIp,
  type CallbackPayload,
} from '../mpesaservice/mpesa.service';
import type { InitiateMpesaInput } from './payment.types';
import type { MpesaCallbackAck } from './payment.types';

// ============================================
// HELPERS
// ============================================

const requireUser = (req: Request): NonNullable<Request['user']> => {
  if (!req.user) throw new AppError(401, 'Authentication required.');
  return req.user;
};

const extractString = (param: string | string[] | undefined): string => {
  if (!param) throw new AppError(400, 'Parameter is required');
  return Array.isArray(param) ? param[0] : param;
};

/**
 * Best-effort client IP extraction. Trusts the first entry in
 * X-Forwarded-For (set by ngrok / your proxy), falls back to the raw
 * socket address.
 */
// Relies on app.set('trust proxy') so req.ip is the real client, not a spoofable header.
const getClientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? '';

// ============================================
// INITIATE STK PUSH
// ============================================
// POST /api/v1/payments/mpesa/initiate

export const initiateMpesaHandler = asyncHandler(
  async (req: Request, res: Response) => {
    requireUser(req);

    const body = req.body as InitiateMpesaInput;

    const result = await initiateMpesaPayment(body);

    res.status(200).json(result);
  },
);

// ============================================
// STATUS POLLING
// ============================================
// GET /api/v1/payments/mpesa/status/:paymentGroupId

export const getPaymentStatusHandler = asyncHandler(
  async (req: Request, res: Response) => {
    requireUser(req);

    const paymentGroupId = extractString(req.params.paymentGroupId);

    const result = await getPaymentStatus(paymentGroupId);

    res.status(200).json(result);
  },
);

// ============================================
// SAFARICOM CALLBACK
// ============================================
// POST /api/v1/payments/mpesa/callback
//
// PUBLIC — Safaricom cannot send a JWT. Source-IP allowlist is the only
// gate. Always respond 200 with the ack shape so Safaricom doesn't retry.

export const mpesaCallbackHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const ip = getClientIp(req);

    if (!isTrustedCallbackIp(ip)) {
      console.warn(`[mpesa] Rejected callback from untrusted IP: ${ip}`);
      // Still 200 — returning an error would cause Safaricom to retry,
      // and a retry storm from an attacker is worse than silently dropping.
      const ack: MpesaCallbackAck = {
        ResultCode: 0,
        ResultDesc: 'Ignored',
      };
      res.status(200).json(ack);
      return;
    }

    const payload = req.body as CallbackPayload;

    try {
      await handleCallback(payload);
    } catch (err) {
      // Do NOT let an internal error turn into a 500 — Safaricom would
      // retry, and if our processing is deterministic-failing, the retries
      // do nothing but burn quota. Log and ack.
      console.error('[mpesa] Callback handling failed:', err);
    }

    const ack: MpesaCallbackAck = {
      ResultCode: 0,
      ResultDesc: 'Accepted',
    };
    res.status(200).json(ack);
  },
);