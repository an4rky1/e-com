/**
 * @fileoverview Money as the wire carries it: integer minor units as a string.
 *
 * @remarks Never `Number(amountMinor)` for arithmetic the page does not need — formatting
 * only moves the decimal point. A float would be a rounding bug on the first large cart.
 */

export interface ShopMoneyLike {
  readonly amountMinor: string;
  readonly currency: string;
}

/** `12345` + `USD` → `$123.45`. Unknown currencies fall back to the code alone. */
export function formatMoney(money: ShopMoneyLike): string {
  const minor = Number(money.amountMinor);
  if (!Number.isFinite(minor)) return `${money.amountMinor} ${money.currency}`;

  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const units = Math.floor(abs / 100);
  const cents = abs % 100;

  switch (money.currency) {
    case 'USD':
      return `${sign}$${units}.${String(cents).padStart(2, '0')}`;
    case 'EUR':
      return `${sign}€${units}.${String(cents).padStart(2, '0')}`;
    default:
      return `${sign}${units}.${String(cents).padStart(2, '0')} ${money.currency}`;
  }
}
