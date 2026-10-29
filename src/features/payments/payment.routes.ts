// src/features/payments/payment.routes.ts

import { Router } from 'express';
import { protect } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import {
  initiateMpesaSchema,
  paymentGroupIdParamSchema,
  mpesaCallbackSchema,
} from './payment.validator';
import {
  initiateMpesaHandler,
  getPaymentStatusHandler,
  mpesaCallbackHandler,
} from './payment.controller';

const router = Router();

// ============================================================
// PAYMENT ROUTES
//
// The callback is PUBLIC — Safaricom cannot send a JWT. It's gated by
// a source-IP allowlist inside the handler (isTrustedCallbackIp).
// ============================================================

/**
 * POST /api/v1/payments/mpesa/initiate
 * Kick off an STK push for a payment group.
 */
router.post(
  '/mpesa/initiate',
  protect,
  validate(initiateMpesaSchema),
  initiateMpesaHandler,
);

/**
 * GET /api/v1/payments/mpesa/status/:paymentGroupId
 * Poll the status of a payment group.
 */
router.get(
  '/mpesa/status/:paymentGroupId',
  protect,
  validate(paymentGroupIdParamSchema),
  getPaymentStatusHandler,
);

/**
 * POST /api/v1/payments/mpesa/callback
 * Safaricom's async callback. PUBLIC — no protect, no JWT.
 */
router.post(
  '/mpesa/callback',
  validate(mpesaCallbackSchema),
  mpesaCallbackHandler,
);

export default router;