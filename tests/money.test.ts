import { describe, expect, it } from 'vitest';
import { allocate, couponDiscount, round2, shippingFee, splitOrder, splitRefund, toCents } from '../src/services/money';

describe('splitOrder', () => {
  it('splits a simple order: 10% commission, shipping goes to the vendor', () => {
    const m = splitOrder({
      items: [{ lineTotal: 1000, ratePct: 10 }],
      shipping: 200,
      vendorDiscount: 0,
      platformDiscount: 0,
    });
    expect(m.customerPays).toBe(1200);
    expect(m.commission).toBe(100);
    expect(m.vendorAmount).toBe(1100); // 1000 - 100 + 200
  });

  it('charges commission on the discounted value, per line rate', () => {
    const m = splitOrder({
      items: [
        { lineTotal: 600, ratePct: 10 },
        { lineTotal: 400, ratePct: 5 },
      ],
      shipping: 0,
      vendorDiscount: 100, // spread 60 / 40
      platformDiscount: 0,
    });
    // (600-60)*10% + (400-40)*5% = 54 + 18
    expect(m.commission).toBe(72);
    expect(m.customerPays).toBe(900);
    expect(m.vendorAmount).toBe(828);
  });

  it('platform-funded discount lowers what the customer pays but not what the vendor earns', () => {
    const m = splitOrder({
      items: [{ lineTotal: 1000, ratePct: 10 }],
      shipping: 0,
      vendorDiscount: 0,
      platformDiscount: 150,
    });
    expect(m.customerPays).toBe(850);
    expect(m.vendorAmount).toBe(900);
    expect(m.commission).toBe(100);
  });

  it('always balances: customerPays + platformDiscount === vendorAmount + commission', () => {
    for (let i = 0; i < 500; i++) {
      const items = Array.from({ length: 1 + (i % 4) }, (_, k) => ({
        lineTotal: round2(((i * 37 + k * 91) % 9000) / 7 + 1),
        ratePct: [0, 5, 7.5, 10, 12.5][(i + k) % 5],
      }));
      const subtotal = items.reduce((a, b) => a + b.lineTotal, 0);
      const m = splitOrder({
        items,
        shipping: round2((i * 13) % 500),
        vendorDiscount: round2(subtotal * ((i % 5) / 20)),
        platformDiscount: round2(subtotal * ((i % 3) / 20)),
      });
      expect(toCents(m.customerPays) + toCents(m.platformDiscount)).toBe(
        toCents(m.vendorAmount) + toCents(m.commission),
      );
      expect(m.vendorAmount).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects discounts larger than the order', () => {
    expect(() =>
      splitOrder({ items: [{ lineTotal: 100, ratePct: 10 }], shipping: 0, vendorDiscount: 100, platformDiscount: 50 }),
    ).toThrow();
  });

  it('avoids floating point drift (0.1 + 0.2 style amounts)', () => {
    const m = splitOrder({
      items: [
        { lineTotal: 0.1, ratePct: 10 },
        { lineTotal: 0.2, ratePct: 10 },
      ],
      shipping: 0,
      vendorDiscount: 0,
      platformDiscount: 0,
    });
    expect(m.itemsSubtotal).toBe(0.3);
    expect(m.customerPays).toBe(0.3);
  });
});

describe('allocate', () => {
  it('always sums exactly to the total', () => {
    for (let t = 0; t < 300; t++) {
      const weights = [t % 7 + 1, (t * 3) % 11 + 1, (t * 5) % 13 + 1];
      const parts = allocate(t * 17, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(t * 17);
    }
  });
  it('returns zeros for a zero total or zero weights', () => {
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
    expect(allocate(10, [0, 0])).toEqual([0, 0]);
  });
});

describe('splitRefund', () => {
  it('splits proportionally and sums to the refund', () => {
    const s = splitRefund(550, 1100, 100); // vendor 11/12, commission 1/12 of the payment
    expect(round2(s.vendor + s.commission)).toBe(550);
    expect(s.vendor).toBeCloseTo(504.17, 2);
    expect(s.commission).toBeCloseTo(45.83, 2);
  });
  it('a full refund returns everything', () => {
    const s = splitRefund(1200, 1100, 100);
    expect(s).toEqual({ vendor: 1100, commission: 100 });
  });
  it('sums exactly even for awkward amounts', () => {
    for (let r = 1; r < 400; r += 7) {
      const s = splitRefund(r / 3, 777.77, 33.33);
      expect(toCents(s.vendor) + toCents(s.commission)).toBe(toCents(r / 3));
    }
  });
});

describe('shippingFee', () => {
  it('base fee covers the first kg, extra kg charged per kg (rounded up)', () => {
    expect(shippingFee({ baseFee: 300, perKgFee: 50, weightKg: 1, subtotal: 1000 })).toBe(300);
    expect(shippingFee({ baseFee: 300, perKgFee: 50, weightKg: 2.1, subtotal: 1000 })).toBe(400);
  });
  it('is free above the threshold', () => {
    expect(shippingFee({ baseFee: 300, perKgFee: 50, weightKg: 5, subtotal: 5000, freeOver: 5000 })).toBe(0);
    expect(shippingFee({ baseFee: 300, perKgFee: 0, weightKg: 1, subtotal: 4999, freeOver: 5000 })).toBe(300);
  });
});

describe('couponDiscount', () => {
  it('percent with cap', () => {
    expect(couponDiscount({ type: 'percent', value: 20, base: 1000 })).toBe(200);
    expect(couponDiscount({ type: 'percent', value: 20, base: 1000, maxDiscount: 150 })).toBe(150);
  });
  it('fixed never exceeds the base', () => {
    expect(couponDiscount({ type: 'fixed', value: 500, base: 300 })).toBe(300);
  });
});

import { refundParts } from '../src/services/money';

describe('refundParts', () => {
  const base = { cashRemaining: 850, vendorRemaining: 900, commissionRemaining: 100, promoRemaining: 150 };

  it('a full refund returns exactly the remainders (including promo reversal)', () => {
    expect(refundParts({ ...base, refund: 850 })).toEqual({ vendor: 900, commission: 100, delivery: 0, promo: 150 });
  });

  it('a partial refund balances: vendor + commission = refund + promo', () => {
    const p = refundParts({ ...base, refund: 425 });
    expect(toCents(p.vendor) + toCents(p.commission)).toBe(toCents(425) + toCents(p.promo));
    expect(p.vendor).toBeLessThanOrEqual(900);
    expect(p.commission).toBeLessThanOrEqual(100);
  });

  it('never exceeds remainders and always balances (many amounts)', () => {
    for (let r = 1; r < 850; r += 13) {
      const p = refundParts({ ...base, refund: r });
      expect(toCents(p.vendor) + toCents(p.commission)).toBe(toCents(r) + toCents(p.promo));
      expect(p.promo).toBeLessThanOrEqual(150);
    }
  });

  it('rejects refunds above what remains', () => {
    expect(() => refundParts({ ...base, refund: 850.01 })).toThrow();
    expect(() => refundParts({ ...base, refund: 0 })).toThrow();
  });
});

describe('delivery fee held by the platform (couriers)', () => {
  it('splitOrder: vendor earns items − commission; delivery is kept separately', () => {
    const m = splitOrder({ items: [{ lineTotal: 1000, ratePct: 10 }], shipping: 200, vendorDiscount: 0, platformDiscount: 0, shippingToPlatform: true });
    expect(m.customerPays).toBe(1200);
    expect(m.commission).toBe(100);
    expect(m.vendorAmount).toBe(900);
    expect(m.delivery).toBe(200);
  });

  it('the default (vendor delivers) is unchanged', () => {
    const m = splitOrder({ items: [{ lineTotal: 1000, ratePct: 10 }], shipping: 200, vendorDiscount: 0, platformDiscount: 0 });
    expect(m.vendorAmount).toBe(1100);
    expect(m.delivery).toBe(0);
  });

  it('always balances with delivery: customerPays + platformDiscount === vendor + commission + delivery', () => {
    for (let i = 0; i < 300; i++) {
      const items = [{ lineTotal: round2(((i * 53) % 7000) / 3 + 5), ratePct: [5, 10, 12.5][i % 3] }];
      const m = splitOrder({ items, shipping: round2((i * 17) % 600), vendorDiscount: round2(items[0].lineTotal * ((i % 4) / 20)), platformDiscount: round2((i % 3) * 7), shippingToPlatform: i % 2 === 0 });
      expect(toCents(m.customerPays) + toCents(m.platformDiscount)).toBe(toCents(m.vendorAmount) + toCents(m.commission) + toCents(m.delivery));
    }
  });

  it('refundParts with delivery: balances and never exceeds any remainder', () => {
    const base = { cashRemaining: 1300, vendorRemaining: 900, commissionRemaining: 100, deliveryRemaining: 300, promoRemaining: 0 };
    expect(refundParts({ ...base, refund: 1300 })).toEqual({ vendor: 900, commission: 100, delivery: 300, promo: 0 });
    for (let r = 1; r < 1300; r += 37) {
      const p = refundParts({ ...base, refund: r });
      expect(toCents(p.vendor) + toCents(p.commission) + toCents(p.delivery)).toBe(toCents(r) + toCents(p.promo));
      expect(p.vendor).toBeLessThanOrEqual(900);
      expect(p.delivery).toBeLessThanOrEqual(300);
    }
  });
});
