// src/services/money.ts
//
// Pure money maths — no database, no I/O — so it can be unit-tested exhaustively.
// All arithmetic is done in integer cents to avoid floating-point drift, and every
// split is built so the parts always sum exactly to the whole.

export const toCents = (amount: number): number => Math.round(amount * 100);
export const fromCents = (cents: number): number => cents / 100;
export const round2 = (amount: number): number => fromCents(toCents(amount));

export interface PricedItem {
  /** price × quantity for this line, before any discount */
  lineTotal: number;
  /** commission percent applying to this line (vendor override > category > default) */
  ratePct: number;
}

export interface OrderMoneyInput {
  items: PricedItem[];
  shipping: number;
  /** discount funded by the vendor (store coupons) — reduces the vendor's earnings */
  vendorDiscount: number;
  /** discount funded by the platform (platform coupons / flash promos) — reduces platform revenue */
  platformDiscount: number;
  /** true when Loom hires the courier: the delivery fee goes to the platform instead of the vendor */
  shippingToPlatform?: boolean;
}

export interface OrderMoney {
  itemsSubtotal: number;
  /** what the customer actually pays */
  customerPays: number;
  commission: number;
  /** what the vendor is owed once escrow releases: items − vendor discount − commission (+ shipping if the vendor delivers) */
  vendorAmount: number;
  /** delivery fee kept by the platform to pay couriers (0 when the vendor delivers) */
  delivery: number;
  platformDiscount: number;
}

/**
 * Splits one vendor's order into customer payment, platform commission and vendor earnings.
 * Commission is charged on item value after the vendor's own discount (never on shipping).
 * The vendor discount is spread across lines in proportion to line value so each line's
 * commission rate is applied to its own discounted value.
 */
export const splitOrder = (input: OrderMoneyInput): OrderMoney => {
  const lines = input.items.map((i) => toCents(i.lineTotal));
  const subtotal = lines.reduce((a, b) => a + b, 0);
  const shipping = toCents(input.shipping);
  const vendorDiscount = Math.min(toCents(input.vendorDiscount), subtotal);
  const platformDiscount = toCents(input.platformDiscount);

  if (platformDiscount + vendorDiscount > subtotal + shipping) {
    throw new Error('Discounts exceed the order value');
  }

  // Allocate the vendor discount across lines (largest-remainder so the parts sum exactly).
  const shares = allocate(vendorDiscount, lines);

  let commission = 0;
  input.items.forEach((item, idx) => {
    const net = lines[idx] - shares[idx];
    commission += Math.round((net * item.ratePct) / 100);
  });

  const deliveryToPlatform = input.shippingToPlatform ? shipping : 0;
  const vendorAmount = subtotal - vendorDiscount - commission + (shipping - deliveryToPlatform);
  const customerPays = subtotal + shipping - vendorDiscount - platformDiscount;

  return {
    itemsSubtotal: fromCents(subtotal),
    customerPays: fromCents(customerPays),
    commission: fromCents(commission),
    vendorAmount: fromCents(vendorAmount),
    delivery: fromCents(deliveryToPlatform),
    platformDiscount: fromCents(platformDiscount),
  };
};

/** Splits `total` cents across `weights` proportionally; the result always sums to `total`. */
export const allocate = (total: number, weights: number[]): number[] => {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);

  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);

  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
};

export interface RefundSplit {
  /** portion taken from the vendor's side of escrow / balance */
  vendor: number;
  /** portion taken back from platform commission */
  commission: number;
}

/**
 * Allocates a customer refund between vendor and platform commission in proportion to how the
 * original payment was split. vendor + commission always equals `refund` exactly.
 */
export const splitRefund = (refund: number, vendorAmount: number, commission: number): RefundSplit => {
  const [vendor, comm] = allocate(toCents(refund), [toCents(vendorAmount), toCents(commission)]);
  return { vendor: fromCents(vendor), commission: fromCents(comm) };
};

/** Delivery fee for a zone: base + per-kg, free above a subtotal threshold. */
export const shippingFee = (opts: {
  baseFee: number;
  perKgFee: number;
  weightKg: number;
  subtotal: number;
  freeOver?: number | null;
}): number => {
  if (opts.freeOver != null && opts.subtotal >= opts.freeOver) return 0;
  const extraKg = Math.max(0, Math.ceil(opts.weightKg) - 1);
  return round2(opts.baseFee + extraKg * opts.perKgFee);
};

/** Discount a coupon gives on `base` (never more than the base, never negative). */
export const couponDiscount = (opts: {
  type: 'percent' | 'fixed';
  value: number;
  base: number;
  maxDiscount?: number | null;
}): number => {
  let d = opts.type === 'percent' ? (opts.base * opts.value) / 100 : opts.value;
  if (opts.maxDiscount != null) d = Math.min(d, opts.maxDiscount);
  return round2(Math.max(0, Math.min(d, opts.base)));
};

export interface RefundParts {
  vendor: number;
  commission: number;
  /** platform-held delivery fee returned */
  delivery: number;
  /** platform-funded discount reversed (credited back to promo expense) */
  promo: number;
}

/**
 * Splits a refund of `refund` (cash back to the customer) into the vendor, commission, delivery and
 * promo parts of the remaining escrow. vendor + commission + delivery === refund + promo, always, so the ledger
 * entry balances; a refund of everything remaining returns exactly the remainders.
 */
export const refundParts = (opts: {
  refund: number;
  cashRemaining: number;
  vendorRemaining: number;
  commissionRemaining: number;
  promoRemaining: number;
  deliveryRemaining?: number;
}): RefundParts => {
  const R = toCents(opts.refund);
  const C = toCents(opts.cashRemaining);
  const vRem = toCents(opts.vendorRemaining);
  const cRem = toCents(opts.commissionRemaining);
  const pRem = toCents(opts.promoRemaining);
  const dRem = toCents(opts.deliveryRemaining ?? 0);

  if (R <= 0) throw new Error('Refund must be positive');
  if (R > C) throw new Error('Refund exceeds the amount still refundable');
  if (R === C) return { vendor: fromCents(vRem), commission: fromCents(cRem), delivery: fromCents(dRem), promo: fromCents(pRem) };

  const promo = Math.min(pRem, Math.round((pRem * R) / C));
  const [vendor, commission, delivery] = allocate(R + promo, [vRem, cRem, dRem]);
  return { vendor: fromCents(vendor), commission: fromCents(commission), delivery: fromCents(delivery), promo: fromCents(promo) };
};
