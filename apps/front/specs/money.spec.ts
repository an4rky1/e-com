import { formatMoney } from '../src/lib/money';

describe('formatMoney', () => {
  it('renders USD with a dollar sign and two decimals', () => {
    expect(formatMoney({ amountMinor: '12345', currency: 'USD' })).toBe('$123.45');
  });

  it('renders EUR with the euro sign', () => {
    expect(formatMoney({ amountMinor: '99', currency: 'EUR' })).toBe('€0.99');
  });

  it('falls back to the code for an unknown currency', () => {
    expect(formatMoney({ amountMinor: '100', currency: 'GBP' })).toBe('1.00 GBP');
  });

  it('keeps a negative amount signed without ever going through float rounding', () => {
    expect(formatMoney({ amountMinor: '-5', currency: 'USD' })).toBe('-$0.05');
  });
});
