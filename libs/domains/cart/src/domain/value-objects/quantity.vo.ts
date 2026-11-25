/**
 * @fileoverview How many units of one SKU a cart line holds.
 *
 * @remarks Quantity is a count of whole units, never money and never a fraction. Keeping it
 * a value object means the same three rules hold everywhere — a positive integer on input,
 * an exact sum on merge, and a safe integer after every addition — instead of each handler
 * and aggregate method re-deciding what "one more" may mean.
 *
 * @remarks The per-item ceiling is deliberately *not* part of the value: a merge is allowed
 * to go above it, because refusing a sign-in over two half-full carts is worse than a line
 * the shopper can lower. The ceiling is a cart rule and is applied by {@link assertAtMost}
 * where a caller is explicitly asking for more.
 */
import { ValueObject } from '@auth/core';
import { ValidationException } from '@auth/platform/error-handling';

export interface QuantityProps {
  readonly value: number;
}

export class Quantity extends ValueObject<QuantityProps> {
  private constructor(props: QuantityProps) {
    super(props);
  }

  /**
   * @param message Overridden when the caller can say something more useful about *why* a
   * zero is wrong — an absolute update has a dedicated removal call, and saying so saves
   * the client a round trip to discover it.
   */
  static of(raw: unknown, message = 'quantity must be a positive integer'): Quantity {
    if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
      throw new ValidationException(message, {
        quantity: raw,
      });
    }

    return new Quantity({ value: raw as number });
  }

  get value(): number {
    return this.props.value;
  }

  isAtMost(maximum: number): boolean {
    return this.props.value <= maximum;
  }

  /** The ceiling check an add or an absolute update owes the caller. */
  assertAtMost(maximum: number, context: Record<string, unknown> = {}): void {
    if (this.isAtMost(maximum)) return;

    throw new ValidationException('quantity exceeds the per-item limit', {
      ...context,
      quantity: this.props.value,
      maxQuantityPerItem: maximum,
    });
  }

  /**
   * Adds another count.
   *
   * @remarks Goes back through {@link of}, so an addition that leaves the safe-integer
   * range is refused rather than silently rounded — the same guard `Money.multiply` relies
   * on when it turns a quantity into a line total.
   */
  plus(other: Quantity): Quantity {
    return Quantity.of(this.props.value + other.value);
  }

  override toString(): string {
    return String(this.props.value);
  }
}
