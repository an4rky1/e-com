/**
 * @fileoverview The lifecycle a stored cart is in.
 *
 * @remarks A string union rather than a TypeScript `enum`: the stored document is JSON and
 * the wire is plain text, and an enum would add runtime code without adding a rule. The
 * list lives beside the other cart value objects so the store's schema, the aggregate and
 * the read model all widen together when checkout introduces a new state.
 */

export const CART_STATUSES = [
  'active',
  'converting',
  'converted',
  'expired',
  'abandoned',
] as const;

export type CartStatus = (typeof CART_STATUSES)[number];

export function isCartStatus(value: unknown): value is CartStatus {
  return typeof value === 'string' && (CART_STATUSES as readonly string[]).includes(value);
}
