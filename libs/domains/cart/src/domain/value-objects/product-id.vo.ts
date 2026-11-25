/**
 * @fileoverview The catalogue product a cart line points at.
 *
 * @remarks Separate from {@link Sku} on purpose: a product may have several variants, and a
 * cart line buys a variant while checkout and receipts refer to the product. Branding the
 * two means a call that needs one cannot silently receive the other — both are strings, and
 * a swap would otherwise compile and send a customer to the wrong item.
 */
import { ValueObject } from '@auth/core';
import { ValidationException } from '@auth/platform/error-handling';

export interface ProductIdProps {
  readonly value: string;
}

export class ProductId extends ValueObject<ProductIdProps> {
  private constructor(props: ProductIdProps) {
    super(props);
  }

  static of(raw: unknown): ProductId {
    if (typeof raw !== 'string') {
      throw new ValidationException('productId is required', { productId: raw });
    }

    const value = raw.trim();
    if (value.length === 0) {
      throw new ValidationException('productId is required', { productId: raw });
    }

    return new ProductId({ value });
  }

  get value(): string {
    return this.props.value;
  }

  override toString(): string {
    return this.props.value;
  }
}
