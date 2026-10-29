// src/features/addresses/address.types.ts

// ============================================
// ENTITY
// ============================================
//
// Mirrors the `addresses` table. Column names here match what
// order.service.ts reads in resolveShippingAddress() — first_name /
// last_name / address_line1 / address_line2 — because that's the
// shape the checkout flow snapshots.

export interface Address {
  id: string;
  user_id: string;

  label: string | null;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company: string | null;

  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string | null;
  postal_code: string;
  country: string;
  instructions: string | null;

  is_default: boolean;

  created_at: Date;
  updated_at: Date;
}

// ============================================
// INPUTS
// ============================================

/**
 * POST /addresses
 *
 * `is_default` is optional on create — if true, the service clears the
 * flag on the user's other addresses in the same transaction.
 */
export interface CreateAddressInput {
  label?: string | null;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company?: string | null;

  address_line1: string;
  address_line2?: string | null;
  city: string;
  state?: string | null;
  postal_code: string;
  country?: string;
  instructions?: string | null;

  is_default?: boolean;
}

/**
 * PATCH /addresses/:addressId
 *
 * Every field optional. The service rejects an empty body.
 */
export type UpdateAddressInput = Partial<CreateAddressInput>;

// ============================================
// RESPONSES
// ============================================

export interface AddressResponse {
  success: boolean;
  message?: string;
  data: Address;
}

export interface AddressesListResponse {
  success: boolean;
  data: Address[];
}