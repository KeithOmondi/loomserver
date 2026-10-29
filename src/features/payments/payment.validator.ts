// src/features/payments/payment.validator.ts

import { z } from 'zod';

// ============================================
// SHARED FIELDS
// ============================================

const uuidSchema = z.string().uuid('Invalid UUID format');

// ============================================
// INITIATE STK PUSH
// ============================================
// POST /payments/mpesa/initiate

/**
 * Phone is optional here — if omitted, the server falls back to the
 * phone on the order's shipping snapshot. When provided, it must
 * normalize to 254XXXXXXXXX. We accept common Kenyan formats and let
 * the service normalize; the regex is intentionally permissive.
 */
const phoneSchema = z
  .string()
  .regex(
    /^(?:\+?254|0)\d{9}$/,
    'Phone must be a valid Kenyan number (e.g. 0712345678 or 254712345678)',
  )
  .optional();

export const initiateMpesaSchema = z.object({
  body: z.object({
    payment_group_id: uuidSchema,
    phone: phoneSchema,
  }),
});

export type InitiateMpesaBody = z.infer<typeof initiateMpesaSchema>['body'];

// ============================================
// STATUS POLLING
// ============================================
// GET /payments/mpesa/status/:paymentGroupId

export const paymentGroupIdParamSchema = z.object({
  params: z.object({
    paymentGroupId: uuidSchema,
  }),
});

// ============================================
// SAFARICOM CALLBACK
// ============================================
// POST /payments/mpesa/callback
//
// Safaricom's payload shape is not stable across environments. We accept
// anything (passthrough) and validate the fields we actually read inside
// the handler. Failing here would 400 the callback and leave customers
// paid-but-unmarked — worse than processing a slightly odd payload.

export const mpesaCallbackSchema = z
  .object({
    Body: z
      .object({
        stkCallback: z
          .object({
            MerchantRequestID: z.string().optional(),
            CheckoutRequestID: z.string().optional(),
            ResultCode: z.number().optional(),
            ResultDesc: z.string().optional(),
            CallbackMetadata: z
              .object({
                Item: z
                  .array(
                    z.object({
                      Name: z.string(),
                      Value: z.union([z.string(), z.number()]).optional(),
                    }),
                  )
                  .optional(),
              })
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();