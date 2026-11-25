/**
 * @fileoverview Money as the cart domain understands it: an exact amount of one currency.
 *
 * @remarks The amount is an integer of minor units, never a floating-point major unit. A
 * price of `12.34` is `1234` here, so every sum and multiplication is exact and a total
 * cannot drift by a cent after a few operations. The currency is part of the value, which
 * is what makes `usd + eur` a rejected operation instead of a number nobody can interpret.
 *
 * @remarks This is the only place the cart validates a price. `CartItem` no longer owns a
 * loose `unitPriceMinor` and `currency` pair, because two fields can disagree: a line could
 * carry a valid amount with an empty or malformed code and the aggregate would still sum
 * it. Constructing `Money` is therefore the proof that both halves are valid.
 *
 * @remarks The wire shape stays flat (`{ amountMinor, currency }`) in `src/money.ts`; this
 * class deliberately knows nothing about gRPC or JSON. A transport that needs the flat
 * shape converts at its boundary, and the domain stays free of transport concerns.
 */
import { ValidationException } from '@auth/platform/error-handling';

/** ISO-4217 alphabetic code, exactly three capital letters. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly minor: number,
    private readonly code: string,
  ) {}

  /**
   * The only way to create money.
   *
   * @remarks Non-negative on purpose: a cart line is a price the shopper is asked to pay,
   * and a minus sign here would be a credit nobody authorised. Discounts belong to
   * billing, where they are modelled explicitly rather than as a negative price.
   */
  static of(amountMinor: number, currency: string): Money {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new ValidationException(
        'amount must be a non-negative integer of minor units',
        { amountMinor },
      );
    }

    const code = typeof currency === 'string' ? currency.trim() : '';
    if (!CURRENCY_PATTERN.test(code)) {
      throw new ValidationException('currency must be a 3-letter ISO-4217 code', {
        currency,
      });
    }

    return new Money(amountMinor, code);
  }

  get amountMinor(): number {
    return this.minor;
  }

  get currency(): string {
    return this.code;
  }

  get isZero(): boolean {
    return this.minor === 0;
  }

  /**
   * Adds two amounts of the same currency.
   *
   * @remarks The currency check is the operation, not a caller's responsibility. A cart
   * that summed dollars and euros would produce a subtotal that no downstream service
   * could charge, and a check that lived at the call site would be one call site behind
   * the next merge.
   */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor + other.minor, this.code);
  }

  /**
   * Multiplies by a whole number of units.
   *
   * @remarks Quantity is a count, not money: a fractional quantity is a caller bug, and a
   * result beyond the safe integer range is refused rather than silently rounded. Zero is
   * allowed so a caller can ask for the value of an empty line without special-casing it.
   */
  multiply(quantity: number): Money {
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new ValidationException('quantity must be a non-negative integer', {
        quantity,
      });
    }

    return Money.of(this.minor * quantity, this.code);
  }

  /** Same amount and same currency. */
  equals(other: Money): boolean {
    return this.minor === other.minor && this.code === other.code;
  }

  private assertSameCurrency(other: Money): void {
    if (this.code !== other.code) {
      throw new ValidationException('money in different currencies cannot be added', {
        leftCurrency: this.code,
        rightCurrency: other.code,
      });
    }
  }
}
