import { parseShopMoney as parseWireMoney, toShopMoney as toWireMoney } from '@auth/infra/shop-money';
import type { ShopMoney } from '@auth/contracts';
import { Money } from './domain/value-objects/money';

export function toShopMoney(money: Money | null): ShopMoney {
  return money === null
    ? toWireMoney(0, '')
    : toWireMoney(money.amountMinor, money.currency);
}

export function parseShopMoney(money: ShopMoney | undefined | null, field: string): Money {
  const amount = parseWireMoney(money, field);
  return Money.of(amount, money?.currency ?? '');
}
