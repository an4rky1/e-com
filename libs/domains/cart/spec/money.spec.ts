/**
 * @fileoverview The two conversions between domain `Money` and `ShopMoney`.
 *
 * @remarks Money crosses the wire as a *string*, and that is the contract rather than an
 * accident: `int64` does not survive a JSON number at 53 bits, so a price large enough to
 * matter would arrive rounded. This copy of the conversion is pinned here so a change to
 * one of the three domains that each keep their own cannot drift silently — a domain lib
 * must not depend on a sibling, and a shared money module would make three services' wire
 * formats one thing to change.
 *
 * @remarks The interesting cases are the ones that coerce *successfully* into the wrong
 * number: `Number("12.34")` is 12, `Number("1e3")` is 1000. Both are a price that is wrong
 * in a way nobody notices until reconciliation, so both are refused rather than parsed.
 */
import { Money } from '../src/domain/value-objects/money';
import { parseShopMoney, toShopMoney } from '../src/money';

describe('toShopMoney', () => {
  it('serialises an integer of minor units as a string', () => {
    expect(toShopMoney(Money.of(2_000, 'EUR'))).toEqual({
      amountMinor: '2000',
      currency: 'EUR',
    });
  });

  it('serialises zero, because a free line is still a price', () => {
    expect(toShopMoney(Money.of(0, 'USD'))).toEqual({ amountMinor: '0', currency: 'USD' });
  });

  it('represents an empty cart as zero with no currency', () => {
    // An empty cart has no currency. Substituting `USD` here would put a code on the wire
    // that no line in the basket actually uses.
    expect(toShopMoney(null)).toEqual({ amountMinor: '0', currency: '' });
  });
});

describe('parseShopMoney', () => {
  it('reads an integer literal into Money', () => {
    const money = parseShopMoney({ amountMinor: '2000', currency: 'EUR' }, 'amount');

    expect(money.amountMinor).toBe(2_000);
    expect(money.currency).toBe('EUR');
  });

  it('reads zero', () => {
    expect(parseShopMoney({ amountMinor: '0', currency: 'USD' }, 'amount').amountMinor).toBe(0);
  });

  it('ignores padding the client added around the amount', () => {
    expect(
      parseShopMoney({ amountMinor: '  2000  ', currency: 'USD' }, 'amount').amountMinor,
    ).toBe(2_000);
  });

  it('refuses a missing field rather than reading it as free', () => {
    // A caller that forgot to send a price did not mean "free", and a product listed at
    // zero because of a missing field is a discount nobody authorised.
    for (const money of [undefined, null]) {
      expect(() => parseShopMoney(money, 'amount')).toThrow(/amount is required/);
    }
  });

  it('refuses a non-string amount the way a typed client could still send one', () => {
    expect(() =>
      parseShopMoney({ amountMinor: 2000 as unknown as string, currency: 'USD' }, 'amount'),
    ).toThrow(/amount is required/);
  });

  it.each([
    ['a decimal', '10.50'],
    ['scientific notation', '1e3'],
    ['a negative', '-5'],
    ['empty', ''],
    ['a hex literal', '0x10'],
    ['letters', 'two thousand'],
  ])('refuses %s rather than coercing it', (_label, amountMinor) => {
    expect(() => parseShopMoney({ amountMinor, currency: 'USD' }, 'amount')).toThrow(
      /amount\.amountMinor must be a non-negative integer literal/,
    );
  });

  it('refuses an amount past the safe integer range', () => {
    expect(() =>
      parseShopMoney({ amountMinor: '99999999999999999999', currency: 'USD' }, 'amount'),
    ).toThrow(/out of range/);
  });

  it('refuses a price without a valid currency', () => {
    expect(() => parseShopMoney({ amountMinor: '100', currency: '' }, 'amount')).toThrow(
      /ISO-4217/,
    );
    expect(() => parseShopMoney({ amountMinor: '100', currency: 'usd' }, 'amount')).toThrow(
      /ISO-4217/,
    );
  });

  it('round-trips every figure it formats', () => {
    for (const amount of [0, 1, 999, 123_456_789]) {
      const money = parseShopMoney(toShopMoney(Money.of(amount, 'USD')), 'amount');
      expect(money.amountMinor).toBe(amount);
      expect(money.currency).toBe('USD');
    }
  });

  it('names the field it was asked about, so the error points at the caller', () => {
    expect(() =>
      parseShopMoney({ amountMinor: 'x', currency: 'USD' }, 'lines[1].unitPrice'),
    ).toThrow(/lines\[1\]\.unitPrice\.amountMinor/);
  });
});
