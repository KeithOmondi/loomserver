// src/features/addresses/address.validator.ts

import { z } from 'zod';

// ============================================
// SHARED FIELDS
// ============================================

const uuidSchema = z.string().uuid('Invalid UUID format');

// ============================================
// BODY
// ============================================

/**
 * Body shape for creating or updating an address. Field names match
 * the `addresses` table (and the shape order.service.ts snapshots
 * into orders.shipping.address).
 */
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
  country: z
    .string()
    .length(2, 'Country must be a 2-letter ISO code')
    .toUpperCase()
    .default('KE'),
  instructions: z.string().max(500).optional().nullable(),

  is_default: z.boolean().optional(),
});

export type AddressBody = z.infer<typeof addressBodySchema>;

// ============================================
// CREATE — POST /addresses
// ============================================

export const createAddressSchema = z.object({
  body: addressBodySchema,
});

export type CreateAddressBody = z.infer<typeof createAddressSchema>['body'];

// ============================================
// UPDATE — PATCH /addresses/:addressId
// ============================================

export const updateAddressSchema = z.object({
  params: z.object({
    addressId: uuidSchema,
  }),
  body: addressBodySchema
    .partial()
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export type UpdateAddressBody = z.infer<typeof updateAddressSchema>['body'];

// ============================================
// PARAM — :addressId
// ============================================

/** GET /addresses/:addressId · DELETE /addresses/:addressId */
export const addressIdParamSchema = z.object({
  params: z.object({
    addressId: uuidSchema,
  }),
});

// ============================================
// SET DEFAULT — PATCH /addresses/:addressId/default
// ============================================

export const setDefaultAddressSchema = z.object({
  params: z.object({
    addressId: uuidSchema,
  }),
});