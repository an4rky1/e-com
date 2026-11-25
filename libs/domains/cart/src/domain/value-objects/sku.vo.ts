/**
 * @fileoverview The stock-keeping unit a cart line is keyed by.
 *
 * @remarks A SKU is the cart's identity for a line: two lines are the same line when their
 * SKUs are equal, so the whitespace that arrived on the wire must not decide that. Trimming
 * happens once here rather than at every handler, aggregate lookup and catalogue call —
 * a trim that lived at one call site and not another would split one product into two
 * baskets depending on which transport the request came through.
 */
import { ValueObject } from '@auth/core';
import { ValidationException } from '@auth/platform/error-handling';

export interface SkuProps {
  readonly value: string;
}

export class Sku extends ValueObject<SkuProps> {
  private constructor(props: SkuProps) {
    super(props);
  }

  /**
   * Validates a SKU arriving from a caller.
   *
   * @remarks Throws rather than returning a `Result` because a malformed SKU is a request
   * the transport must reject as a 400, and every caller in this service already translates
   * `ValidationException` into exactly that.
   */
  static of(raw: unknown): Sku {
    if (typeof raw !== 'string') {
      throw new ValidationException('sku is required', { sku: raw });
    }

    const value = raw.trim();
    if (value.length === 0) {
      throw new ValidationException('sku is required', { sku: raw });
    }

    return new Sku({ value });
  }

  get value(): string {
    return this.props.value;
  }

  override toString(): string {
    return this.props.value;
  }
}
