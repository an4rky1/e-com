/**
 * @fileoverview Constants shared by the storefront pages and their HTTP layer.
 *
 * @remarks The names live here rather than at each use site so the wire contract — the
 * `Content-Type` every storefront request sets and the message shown when the gateway is
 * unreachable — has one spelling a reader can trust.
 */

/** `Content-Type` header value every storefront JSON request sends. */
export const JSON_CONTENT_TYPE = 'application/json';

/** Fallback message when the gateway is unreachable or answers nothing parseable. */
export const GATEWAY_UNAVAILABLE_MESSAGE = 'The gateway did not answer';
