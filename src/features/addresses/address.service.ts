// src/features/addresses/address.service.ts

import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import type {
  Address,
  CreateAddressInput,
  UpdateAddressInput,
} from './address.types';

// ============================================
// CONSTANTS
// ============================================

const MAX_ADDRESSES_PER_USER = 20;

// ============================================
// HELPERS
// ============================================

const mapRowToAddress = (row: any): Address => ({
  id: row.id,
  user_id: row.user_id,
  label: row.label,
  first_name: row.first_name,
  last_name: row.last_name,
  email: row.email,
  phone: row.phone,
  company: row.company,
  address_line1: row.address_line1,
  address_line2: row.address_line2,
  city: row.city,
  state: row.state,
  postal_code: row.postal_code,
  country: row.country,
  instructions: row.instructions,
  is_default: row.is_default,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/**
 * Clear is_default on every other address the user owns, inside the
 * caller's transaction. Called whenever we set an address to default.
 */
const clearOtherDefaults = async (
  client: PoolClient,
  userId: string,
  exceptAddressId: string | null,
): Promise<void> => {
  if (exceptAddressId) {
    await client.query(
      `UPDATE addresses
       SET is_default = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND id <> $2 AND is_default = TRUE`,
      [userId, exceptAddressId],
    );
  } else {
    await client.query(
      `UPDATE addresses
       SET is_default = FALSE, updated_at = NOW()
       WHERE user_id = $1 AND is_default = TRUE`,
      [userId],
    );
  }
};

// ============================================
// LIST — GET /addresses
// ============================================

export const getUserAddresses = async (
  userId: string,
): Promise<Address[]> => {
  const result = await pool.query(
    `SELECT * FROM addresses
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at DESC`,
    [userId],
  );
  return result.rows.map(mapRowToAddress);
};

// ============================================
// GET ONE — GET /addresses/:addressId
// ============================================

export const getAddressById = async (
  addressId: string,
  userId: string,
): Promise<Address | null> => {
  const result = await pool.query(
    `SELECT * FROM addresses WHERE id = $1 AND user_id = $2`,
    [addressId, userId],
  );
  return result.rows.length > 0 ? mapRowToAddress(result.rows[0]) : null;
};

// ============================================
// CREATE — POST /addresses
// ============================================

export const createAddress = async (
  userId: string,
  input: CreateAddressInput,
): Promise<Address> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Cap the number of addresses per user so the table can't be
    // used as free storage.
    const countResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM addresses WHERE user_id = $1`,
      [userId],
    );
    const count = parseInt(countResult.rows[0].count, 10);
    if (count >= MAX_ADDRESSES_PER_USER) {
      throw new AppError(
        400,
        `You can save at most ${MAX_ADDRESSES_PER_USER} addresses.`,
      );
    }

    // First address for a user is automatically the default,
    // regardless of what the client sent.
    const shouldBeDefault = count === 0 || input.is_default === true;

    if (shouldBeDefault) {
      await clearOtherDefaults(client, userId, null);
    }

    const result = await client.query(
      `INSERT INTO addresses (
         user_id, label,
         first_name, last_name, email, phone, company,
         address_line1, address_line2, city, state, postal_code,
         country, instructions, is_default,
         created_at, updated_at
       ) VALUES (
         $1, $2,
         $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15,
         NOW(), NOW()
       )
       RETURNING *`,
      [
        userId,
        input.label ?? null,
        input.first_name,
        input.last_name,
        input.email,
        input.phone,
        input.company ?? null,
        input.address_line1,
        input.address_line2 ?? null,
        input.city,
        input.state ?? null,
        input.postal_code,
        input.country ?? 'KE',
        input.instructions ?? null,
        shouldBeDefault,
      ],
    );

    await client.query('COMMIT');
    return mapRowToAddress(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// UPDATE — PATCH /addresses/:addressId
// ============================================

export const updateAddress = async (
  addressId: string,
  userId: string,
  input: UpdateAddressInput,
): Promise<Address> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Ownership check + existence in one round trip.
    const existing = await client.query(
      `SELECT id FROM addresses WHERE id = $1 AND user_id = $2`,
      [addressId, userId],
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Address not found.');
    }

    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    const setField = (column: string, value: any): void => {
      fields.push(`${column} = $${paramCount++}`);
      values.push(value);
    };

    // Only set fields the client actually sent (input is partial).
    if (input.label !== undefined) setField('label', input.label);
    if (input.first_name !== undefined) setField('first_name', input.first_name);
    if (input.last_name !== undefined) setField('last_name', input.last_name);
    if (input.email !== undefined) setField('email', input.email);
    if (input.phone !== undefined) setField('phone', input.phone);
    if (input.company !== undefined) setField('company', input.company);
    if (input.address_line1 !== undefined)
      setField('address_line1', input.address_line1);
    if (input.address_line2 !== undefined)
      setField('address_line2', input.address_line2);
    if (input.city !== undefined) setField('city', input.city);
    if (input.state !== undefined) setField('state', input.state);
    if (input.postal_code !== undefined)
      setField('postal_code', input.postal_code);
    if (input.country !== undefined) setField('country', input.country);
    if (input.instructions !== undefined)
      setField('instructions', input.instructions);

    if (input.is_default === true) {
      await clearOtherDefaults(client, userId, addressId);
      setField('is_default', true);
    }

    if (fields.length === 0) {
      // Shouldn't reach here — validator rejects empty bodies — but
      // guard anyway.
      throw new AppError(400, 'No fields to update.');
    }

    fields.push(`updated_at = NOW()`);
    values.push(addressId);
    values.push(userId);

    const result = await client.query(
      `UPDATE addresses
       SET ${fields.join(', ')}
       WHERE id = $${paramCount++} AND user_id = $${paramCount}
       RETURNING *`,
      values,
    );

    await client.query('COMMIT');
    return mapRowToAddress(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// SET DEFAULT — PATCH /addresses/:addressId/default
// ============================================

export const setDefaultAddress = async (
  addressId: string,
  userId: string,
): Promise<Address> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id FROM addresses WHERE id = $1 AND user_id = $2`,
      [addressId, userId],
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Address not found.');
    }

    await clearOtherDefaults(client, userId, addressId);

    const result = await client.query(
      `UPDATE addresses
       SET is_default = TRUE, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [addressId, userId],
    );

    await client.query('COMMIT');
    return mapRowToAddress(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// DELETE — DELETE /addresses/:addressId
// ============================================

/**
 * Hard delete. Existing orders keep their own snapshot of the address
 * in orders.shipping, so removing the saved row does not affect past
 * orders.
 *
 * If the deleted address was the default and other addresses remain,
 * the most recently created one becomes the new default.
 */
export const deleteAddress = async (
  addressId: string,
  userId: string,
): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query<{ is_default: boolean }>(
      `SELECT is_default FROM addresses WHERE id = $1 AND user_id = $2`,
      [addressId, userId],
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Address not found.');
    }

    const wasDefault = existing.rows[0].is_default;

    await client.query(
      `DELETE FROM addresses WHERE id = $1 AND user_id = $2`,
      [addressId, userId],
    );

    if (wasDefault) {
      const next = await client.query<{ id: string }>(
        `SELECT id FROM addresses
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId],
      );
      if (next.rows.length > 0) {
        await client.query(
          `UPDATE addresses
           SET is_default = TRUE, updated_at = NOW()
           WHERE id = $1`,
          [next.rows[0].id],
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};