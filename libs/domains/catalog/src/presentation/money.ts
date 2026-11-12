/**
 * @fileoverview Conversion between integer minor units and the `ShopMoney` wire shape.
 *
 * @remarks The wire carries money as a *string*, and that is the contract, not an accident:
 * `int64` does not survive a JSON number at 53 bits, so a price large enough to matter would
 * arrive rounded and every sum built on it would quietly gain a unit. Parsing therefore
 * refuses anything that is not an exact integer literal rather than coercing it — `Number`
 * would happily turn `"12.34"` into `12` and `"1e3"` into `1000`, both of which are a price
 * that is wrong in a way nobody notices until reconciliation.
 *
 * @remarks Lives in presentation because `ShopMoney` is a transport shape. The domain only
 * ever sees `number`, so a second transport can reuse the domain without inheriting gRPC's
 * formatting rules.
 */
import { ValidationException } from '@auth/platform/error-handling';
import type { ShopMoney } from '@auth/contracts';

/** Serialises an integer number of minor units onto the wire. */
export function toShopMoney(amountMinor: number, currency: string): ShopMoney {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new ValidationException('amount must be an integer number of minor units', {
      amountMinor,
    });
  }

  return { amountMinor: String(amountMinor), currency };
}

/**
 * Reads a `ShopMoney` off the wire as an integer number of minor units.
 *
 * @remarks Rejects a missing field as a validation error rather than defaulting to `0`:
 * a caller that forgot to send a price did not mean "free", and a product listed at zero
 * because of a missing field is a discount nobody authorised.
 */
export function parseShopMoney(money: ShopMoney | undefined | null, field: string): number {
  if (!money || typeof money.amountMinor !== 'string') {
    throw new ValidationException(`${field} is required`, { field });
  }

  const raw = money.amountMinor.trim();
  if (!/^\d+$/.test(raw)) {
    throw new ValidationException(
      `${field}.amountMinor must be a non-negative integer literal`,
      { field, amountMinor: money.amountMinor },
    );
  }

  const amount = Number(raw);
  if (!Number.isSafeInteger(amount)) {
    throw new ValidationException(`${field}.amountMinor is out of range`, {
      field,
      amountMinor: money.amountMinor,
    });
  }

  return amount;
}
