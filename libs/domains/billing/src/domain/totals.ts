/**
 * @fileoverview The frozen money calculation: tax, then coupon, then total.
 *
 * @remarks One pure function, no I/O and no clock, because this is the arithmetic every
 * other part of billing merely transports: the charge recomputes it to refuse a mismatched
 * amount, the preview shows it, and the invoice stores its result. Three copies of this
 * rule would be three ways for a storefront's displayed price and the money actually
 * taken to disagree.
 *
 * @remarks The order is part of the contract, not an implementation detail:
 * **tax before discount, coupon after tax**. Tax is computed on the undiscounted line
 * subtotals — a coupon reduces what the customer owes, not what the jurisdiction taxed —
 * and the coupon then applies to the post-tax amount. Changing either order silently
 * changes every price the storefront has ever shown.
 *
 * @remarks Every figure is an integer in minor units. A float in a money path diverges
 * from the first sum computed in a different order, and the difference is real money.
 */
import { ValidationException } from '@auth/platform/error-handling';

/** One charge line, already parsed off the wire into minor units. */
export interface TotalsLineInput {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

/** A coupon as the `coupons` table spells it: an integer percentage off. */
export interface CouponInput {
  readonly code: string;
  readonly percentOff: number;
}

/** One line of the computed invoice, with the tax attributed to it. */
export interface ComputedLine {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly lineSubtotalMinor: number;
  readonly taxMinor: number;
}

/** The full result of one calculation, in minor units throughout. */
export interface ComputedTotals {
  readonly lines: readonly ComputedLine[];
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly currency: string;
}

export interface ComputeTotalsInput {
  readonly lines: readonly TotalsLineInput[];
  readonly currency: string;
  /** Basis points: 1900 = 19%. Resolved from the jurisdiction by the caller. */
  readonly taxRateBps: number;
  /** Absent means no coupon, which is the charge path: `ChargeOrderRequest` carries none. */
  readonly coupon?: CouponInput;
}

/**
 * Computes subtotal, per-line tax, coupon discount and total, in that order.
 *
 * @remarks Per-line rounding rather than one tax figure on the aggregate subtotal: the
 * invoice shows a tax amount *per line*, and a tax computed on the sum would not equal
 * the sum of the taxes the invoice displays — a discrepancy a reconciliation would flag
 * as a bug even though both numbers are defensible.
 *
 * @remarks The total is floored at zero. A coupon can never exceed 100%, so the floor is
 * unreachable through a valid coupon; it exists so a future promotion type (fixed-amount
 * off, stacking discounts) cannot make the service charge a negative amount.
 */
export function computeTotals(input: ComputeTotalsInput): ComputedTotals {
  if (input.lines.length === 0) {
    throw new ValidationException('totals require at least one line');
  }
  if (!Number.isSafeInteger(input.taxRateBps) || input.taxRateBps < 0 || input.taxRateBps > 10_000) {
    throw new ValidationException('tax rate must be an integer between 0 and 10000 basis points', {
      taxRateBps: input.taxRateBps,
    });
  }
  const currency = input.currency.trim();
  if (currency.length === 0) {
    throw new ValidationException('currency is required');
  }

  if (input.coupon) {
    if (!Number.isSafeInteger(input.coupon.percentOff) || input.coupon.percentOff <= 0 || input.coupon.percentOff > 100) {
      throw new ValidationException('coupon percent_off must be an integer between 1 and 100', {
        code: input.coupon.code,
        percentOff: input.coupon.percentOff,
      });
    }
  }

  const lines: ComputedLine[] = [];
  let subtotalMinor = 0;
  let taxMinor = 0;

  for (const line of input.lines) {
    const sku = line.sku.trim();
    if (sku.length === 0) {
      throw new ValidationException('every line needs a sku');
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationException('line quantity must be a positive integer', {
        sku,
        quantity: line.quantity,
      });
    }
    if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
      throw new ValidationException('unit price must be a non-negative integer in minor units', {
        sku,
        unitPriceMinor: line.unitPriceMinor,
      });
    }

    const lineSubtotalMinor = line.quantity * line.unitPriceMinor;
    if (!Number.isSafeInteger(lineSubtotalMinor)) {
      throw new ValidationException('line subtotal is out of range', { sku });
    }

    const lineTaxMinor = Math.round((lineSubtotalMinor * input.taxRateBps) / 10_000);

    lines.push({
      sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineSubtotalMinor,
      taxMinor: lineTaxMinor,
    });

    subtotalMinor += lineSubtotalMinor;
    taxMinor += lineTaxMinor;
  }

  // The coupon applies to the post-tax amount: tax was computed first, on undiscounted
  // lines, and the discount is the last step before the total. See the file header.
  const grossMinor = subtotalMinor + taxMinor;
  const discountMinor = input.coupon
    ? Math.round((grossMinor * input.coupon.percentOff) / 100)
    : 0;

  return {
    lines,
    subtotalMinor,
    taxMinor,
    discountMinor,
    totalMinor: Math.max(0, grossMinor - discountMinor),
    currency,
  };
}
