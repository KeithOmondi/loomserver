// src/features/cart/cart.service.ts

import type { PoolClient } from 'pg';
import { pool } from '../../config/db';
import { AppError } from '../../utils/response';
import type {
  Cart,
  CartLine,
  CartOwner,
  CartWithItems,
  AddCartItemInput,
  UpdateCartItemInput,
} from './cart.types';

// ============================================
// HELPERS — ownership resolution
// ============================================

/**
 * Normalize the incoming request into a CartOwner. Either the user is
 * authenticated (req.user populated by protectOptional) OR a guest token
 * was sent in the X-Cart-Token header. Never both.
 *
 * Precedence: if authenticated, use the user. Else, use the guest token.
 */
export const resolveCartOwner = (
  userId: string | undefined,
  guestToken: string | undefined,
): CartOwner => {
  if (userId) return { kind: 'user', user_id: userId };
  if (guestToken) return { kind: 'guest', guest_token: guestToken };
  throw new AppError(400, 'Cart token required.');
};

// ============================================
// HELPERS — cart lookup / creation
// ============================================

const findCartByOwner = async (
  owner: CartOwner,
  client?: PoolClient,
): Promise<Cart | null> => {
  const q = client ?? pool;
  const result = owner.kind === 'user'
    ? await q.query<Cart>(
        `SELECT * FROM carts WHERE user_id = $1 LIMIT 1`,
        [owner.user_id],
      )
    : await q.query<Cart>(
        `SELECT * FROM carts WHERE guest_token = $1 LIMIT 1`,
        [owner.guest_token],
      );
  return result.rows[0] ?? null;
};

const createCart = async (
  owner: CartOwner,
  client?: PoolClient,
): Promise<Cart> => {
  const q = client ?? pool;
  const result = owner.kind === 'user'
    ? await q.query<Cart>(
        `INSERT INTO carts (user_id, last_activity_at, created_at, updated_at)
         VALUES ($1, NOW(), NOW(), NOW())
         RETURNING *`,
        [owner.user_id],
      )
    : await q.query<Cart>(
        `INSERT INTO carts (guest_token, last_activity_at, created_at, updated_at)
         VALUES ($1, NOW(), NOW(), NOW())
         RETURNING *`,
        [owner.guest_token],
      );
  return result.rows[0];
};

/**
 * Return the cart for this owner, creating one if none exists yet.
 */
const getOrCreateCart = async (
  owner: CartOwner,
  client?: PoolClient,
): Promise<Cart> => {
  const existing = await findCartByOwner(owner, client);
  if (existing) return existing;
  return createCart(owner, client);
};

const touchCart = async (cartId: string, client?: PoolClient): Promise<void> => {
  const q = client ?? pool;
  await q.query(
    `UPDATE carts SET last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [cartId],
  );
};

// ============================================
// HELPERS — hydration
// ============================================

/**
 * Load cart items for a cart, joined with product + primary image.
 * Returns the hydrated CartWithItems shape ready for the API.
 */
const hydrateCart = async (
  cart: Cart,
  client?: PoolClient,
): Promise<CartWithItems> => {
  const q = client ?? pool;

  const itemsResult = await q.query<{
    id: string;
    product_id: string;
    quantity: number;
    unit_price: string;
    // product fields
    p_id: string;
    p_name: string;
    p_slug: string;
    p_price: string;
    p_compare_at_price: string | null;
    p_status: string;
    p_stock_quantity: number;
    p_stock_status: string;
    p_is_active: boolean;
    // image fields
    img_id: string | null;
    img_product_id: string | null;
    img_url: string | null;
    img_public_id: string | null;
    img_alt_text: string | null;
    img_is_primary: boolean | null;
    img_sort_order: number | null;
    img_metadata: Record<string, unknown> | null;
    img_created_at: Date | null;
    variant_id: string | null;
    v_name: string | null;
    v_price: string | null;
    v_stock: number | null;
    v_image: string | null;
    p_backorders: boolean;
    flash_price: string | null;
  }>(
    `SELECT
       ci.id,
       ci.product_id,
       ci.quantity,
       ci.unit_price,
       ci.variant_id,
       pv.name               AS v_name,
       pv.price              AS v_price,
       pv.stock_quantity     AS v_stock,
       pv.image_url          AS v_image,
       p.allow_backorders    AS p_backorders,
       fl.sale_price         AS flash_price,

       p.id                  AS p_id,
       p.name                AS p_name,
       p.slug                AS p_slug,
       p.price               AS p_price,
       p.compare_at_price    AS p_compare_at_price,
       p.status              AS p_status,
       p.stock_quantity      AS p_stock_quantity,
       p.stock_status        AS p_stock_status,
       p.is_active           AS p_is_active,

       img.id                AS img_id,
       img.product_id        AS img_product_id,
       img.url               AS img_url,
       img.public_id         AS img_public_id,
       img.alt_text          AS img_alt_text,
       img.is_primary        AS img_is_primary,
       img.sort_order        AS img_sort_order,
       img.metadata          AS img_metadata,
       img.created_at        AS img_created_at
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN product_variants pv ON pv.id = ci.variant_id
     LEFT JOIN LATERAL (
       SELECT fi.sale_price
       FROM flash_sale_items fi JOIN flash_sales fs ON fs.id = fi.flash_sale_id
       WHERE fi.product_id = p.id AND fs.is_active AND fs.starts_at <= NOW() AND fs.ends_at >= NOW()
       ORDER BY fi.sale_price ASC LIMIT 1
     ) fl ON TRUE
     LEFT JOIN LATERAL (
       SELECT *
       FROM product_images
       WHERE product_id = p.id
       ORDER BY is_primary DESC, sort_order ASC, created_at ASC
       LIMIT 1
     ) img ON TRUE
     WHERE ci.cart_id = $1
     ORDER BY ci.created_at ASC`,
    [cart.id],
  );

  const items: CartLine[] = itemsResult.rows.map((row) => {
    const quantity = row.quantity;
    // Show what checkout will actually charge: live variant price, or the product price
    // (lowered by an active flash sale) — not the snapshot taken when the item was added.
    const unitPrice = row.variant_id
      ? Number(row.v_price)
      : Math.min(Number(row.p_price), row.flash_price != null ? Number(row.flash_price) : Number(row.p_price));
    const lineTotal = Math.round(quantity * unitPrice * 100) / 100;
    const stockQty = row.variant_id ? row.v_stock ?? 0 : row.p_stock_quantity;
    const isAvailable =
      row.p_is_active === true && row.p_status === 'active';
    const inStock =
      isAvailable &&
      (row.p_backorders || stockQty >= quantity);

    return {
      id: row.id,
      product: {
        id: row.p_id,
        name: row.p_name,
        slug: row.p_slug,
        price: Number(row.p_price),
        compare_at_price:
          row.p_compare_at_price !== null ? Number(row.p_compare_at_price) : null,
        status: row.p_status as any,
        stock_quantity: stockQty,
        stock_status: row.p_stock_status,
        is_active: row.p_is_active,
        image: row.v_image
          ? { id: row.variant_id as string, product_id: row.p_id, url: row.v_image, public_id: '', alt_text: null, is_primary: true, sort_order: 0, metadata: null, created_at: new Date() }
          : row.img_id
          ? {
              id: row.img_id,
              product_id: row.img_product_id as string,
              url: row.img_url as string,
              public_id: row.img_public_id as string,
              alt_text: row.img_alt_text,
              is_primary: row.img_is_primary as boolean,
              sort_order: row.img_sort_order as number,
              metadata: row.img_metadata,
              created_at: row.img_created_at as Date,
            }
          : null,
      },
      variant_id: row.variant_id,
      variant_name: row.v_name,
      quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      in_stock: inStock,
      is_available: isAvailable,
    };
  });

  const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  const result: CartWithItems = {
    id: cart.id,
    items,
    subtotal,
    item_count: itemCount,
  };
  if (cart.guest_token) {
    result.guest_token = cart.guest_token;
  }
  return result;
};

// ============================================
// PUBLIC — read
// ============================================

export const getCart = async (owner: CartOwner): Promise<CartWithItems> => {
  const cart = await getOrCreateCart(owner);
  return hydrateCart(cart);
};

// ============================================
// PUBLIC — add item
// ============================================

export const addItem = async (
  owner: CartOwner,
  input: AddCartItemInput,
): Promise<CartWithItems> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cart = await getOrCreateCart(owner, client);

    // Verify the product exists and is purchasable
    const productResult = await client.query<{
      id: string;
      price: string;
      status: string;
      is_active: boolean;
      stock_quantity: number;
      allow_backorders: boolean;
      has_variants: boolean;
    }>(
      `SELECT id, price, status, is_active, stock_quantity, allow_backorders, has_variants
       FROM products
       WHERE id = $1 AND deleted_at IS NULL`,
      [input.product_id],
    );
    if (productResult.rows.length === 0) {
      throw new AppError(404, 'Product not found.');
    }
    const product = productResult.rows[0];
    if (!product.is_active || product.status !== 'active') {
      throw new AppError(409, 'Product is not available for purchase.');
    }

    // Upsert: if same (product, variant) exists, increment quantity
    const variantId = input.variant_id ?? null;
    const quantity = input.quantity ?? 1;

    // Variant products must be added with a valid, active variant; price and stock come from it.
    let unitPrice = Number(product.price);
    let stockQuantity = product.stock_quantity;
    if (variantId) {
      const v = await client.query<{ price: string; stock_quantity: number }>(
        `SELECT price, stock_quantity FROM product_variants WHERE id = $1 AND product_id = $2 AND is_active = true`,
        [variantId, input.product_id],
      );
      if (!v.rows[0]) throw new AppError(400, 'That option is not available for this product.');
      unitPrice = Number(v.rows[0].price);
      stockQuantity = v.rows[0].stock_quantity;
    } else if (product.has_variants) {
      throw new AppError(400, 'Please choose an option (size, colour…) before adding this product.');
    }

    // Look up the existing line ourselves: with a NULL variant_id the unique index never
    // reports a conflict (NULLs are distinct), so ON CONFLICT would create duplicate lines.
    const existing = await client.query<{ id: string; quantity: number }>(
      `SELECT id, quantity FROM cart_items
       WHERE cart_id = $1 AND product_id = $2 AND variant_id IS NOT DISTINCT FROM $3::uuid`,
      [cart.id, input.product_id, variantId],
    );
    const line = existing.rows[0];

    // Don't let a cart hold more than is in stock (resulting line quantity, not just this add).
    if (!product.allow_backorders) {
      if (stockQuantity <= 0) {
        throw new AppError(409, 'This product is out of stock.');
      }
      if ((line?.quantity ?? 0) + quantity > stockQuantity) {
        throw new AppError(409, `Only ${stockQuantity} in stock.`);
      }
    }

    if (line) {
      await client.query(
        `UPDATE cart_items SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2`,
        [quantity, line.id],
      );
    } else {
      await client.query(
        `INSERT INTO cart_items (cart_id, product_id, variant_id, quantity, unit_price, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [cart.id, input.product_id, variantId, quantity, unitPrice],
      );
    }

    await touchCart(cart.id, client);
    await client.query('COMMIT');

    return hydrateCart(cart);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// PUBLIC — update quantity
// ============================================

export const updateItemQuantity = async (
  owner: CartOwner,
  itemId: string,
  input: UpdateCartItemInput,
): Promise<CartWithItems> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cart = await findCartByOwner(owner, client);
    if (!cart) throw new AppError(404, 'Cart not found.');

    // Verify the item belongs to this cart
    const itemCheck = await client.query<{ stock_quantity: number; allow_backorders: boolean }>(
      `SELECT COALESCE(pv.stock_quantity, p.stock_quantity) AS stock_quantity, p.allow_backorders
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN product_variants pv ON pv.id = ci.variant_id
       WHERE ci.id = $1 AND ci.cart_id = $2`,
      [itemId, cart.id],
    );
    if (itemCheck.rows.length === 0) {
      throw new AppError(404, 'Cart item not found.');
    }
    const { stock_quantity, allow_backorders } = itemCheck.rows[0];
    if (!allow_backorders && input.quantity > stock_quantity) {
      throw new AppError(409, stock_quantity <= 0 ? 'This product is out of stock.' : `Only ${stock_quantity} in stock.`);
    }

    await client.query(
      `UPDATE cart_items
       SET quantity = $1, updated_at = NOW()
       WHERE id = $2`,
      [input.quantity, itemId],
    );

    await touchCart(cart.id, client);
    await client.query('COMMIT');

    return hydrateCart(cart);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// PUBLIC — remove item
// ============================================

export const removeItem = async (
  owner: CartOwner,
  itemId: string,
): Promise<CartWithItems> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cart = await findCartByOwner(owner, client);
    if (!cart) throw new AppError(404, 'Cart not found.');

    const deleteResult = await client.query(
      `DELETE FROM cart_items WHERE id = $1 AND cart_id = $2`,
      [itemId, cart.id],
    );
    if (deleteResult.rowCount === 0) {
      throw new AppError(404, 'Cart item not found.');
    }

    await touchCart(cart.id, client);
    await client.query('COMMIT');

    return hydrateCart(cart);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// PUBLIC — clear cart
// ============================================

export const clearCart = async (owner: CartOwner): Promise<CartWithItems> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cart = await findCartByOwner(owner, client);
    if (!cart) {
      // Nothing to clear — return an empty shape
      await client.query('COMMIT');
      const empty: CartWithItems = {
        id: '',
        items: [],
        subtotal: 0,
        item_count: 0,
      };
      if (owner.kind === 'guest') empty.guest_token = owner.guest_token;
      return empty;
    }

    await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cart.id]);
    await touchCart(cart.id, client);
    await client.query('COMMIT');

    return hydrateCart(cart);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// ============================================
// PUBLIC — merge guest cart into user cart
// ============================================

/**
 * Called after login. Moves all items from the guest cart (identified by
 * guest_token) into the authenticated user's cart, then deletes the guest
 * cart.
 *
 * Idempotent: if the guest cart doesn't exist, this is a no-op and returns
 * the user's current cart.
 */
export const mergeGuestCart = async (
  userId: string,
  guestToken: string,
): Promise<{ cart: CartWithItems; merged_items: number }> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load guest cart
    const guestCartResult = await client.query<Cart>(
      `SELECT * FROM carts WHERE guest_token = $1 LIMIT 1`,
      [guestToken],
    );
    const guestCart = guestCartResult.rows[0];

    // Ensure user cart exists
    let userCart = await findCartByOwner({ kind: 'user', user_id: userId }, client);
    if (!userCart) {
      userCart = await createCart({ kind: 'user', user_id: userId }, client);
    }

    // If there was no guest cart, we're done
    if (!guestCart || guestCart.id === userCart.id) {
      await client.query('COMMIT');
      const cart = await hydrateCart(userCart);
      return { cart, merged_items: 0 };
    }

    // Load guest items
    const guestItems = await client.query<{
      product_id: string;
      variant_id: string | null;
      quantity: number;
      unit_price: string;
    }>(
      `SELECT product_id, variant_id, quantity, unit_price
       FROM cart_items
       WHERE cart_id = $1`,
      [guestCart.id],
    );

    let mergedCount = 0;

    for (const item of guestItems.rows) {
      // Upsert into user cart — on conflict, add quantities
      await client.query(
        `INSERT INTO cart_items (
           cart_id, product_id, variant_id, quantity, unit_price,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (cart_id, product_id, variant_id)
         DO UPDATE SET
           quantity = cart_items.quantity + EXCLUDED.quantity,
           updated_at = NOW()`,
        [
          userCart.id,
          item.product_id,
          item.variant_id,
          item.quantity,
          item.unit_price,
        ],
      );
      mergedCount++;
    }

    // Delete the guest cart (cascades to its items)
    await client.query(`DELETE FROM carts WHERE id = $1`, [guestCart.id]);

    await touchCart(userCart.id, client);
    await client.query('COMMIT');

    const cart = await hydrateCart(userCart);
    return { cart, merged_items: mergedCount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};