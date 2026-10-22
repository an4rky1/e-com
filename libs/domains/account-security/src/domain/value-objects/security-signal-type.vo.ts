/**
 * @fileoverview The kinds of thing this service notices.
 *
 * @remarks An `as const` union rather than a TypeScript `enum`, for the same reason as
 * {@link RiskLevel}: the value that lands in `security_signals.signal_type` is the same string
 * that lands in a published `SecurityEventPayload`, and a generated enum would make a string
 * literal typed as something a consumer has to import at runtime to name.
 *
 * @remarks The three names are exactly the three the topic catalogue gives this service. A
 * fourth type would have no topic to ride on, which means an event no consumer could be
 * subscribed to — the failure mode that makes a producer look healthy while its output goes
 * nowhere.
 */
import type { SecurityEventPayload } from '@auth/contracts';

export const SecuritySignalType = {
  /** A login from a fingerprint this account has never used. */
  NEW_DEVICE_DETECTED: 'new_device_detected',
  /** A login whose risk score crossed a threshold worth reviewing. */
  SUSPICIOUS_LOGIN_DETECTED: 'suspicious_login_detected',
  /** Everything else that is not normal: a failure run, a lock, an unlock, a revoked device. */
  ANOMALY_DETECTED: 'anomaly_detected',
} as const;

export type SecuritySignalType = (typeof SecuritySignalType)[keyof typeof SecuritySignalType];

/**
 * Narrows an untrusted string — a `security_signals.signal_type` column, a gRPC field — to a
 * known type.
 *
 * @remarks Used on the read path rather than casting. The column is a `text` field that an
 * operator, a migration or an older row can put anything in, and a cast would let an unknown
 * type through as a valid one until it reached a switch statement that had no branch for it.
 */
export function isSecuritySignalType(value: unknown): value is SecuritySignalType {
  return (
    typeof value === 'string' &&
    (Object.values(SecuritySignalType) as string[]).includes(value)
  );
}

/**
 * The published payload type, named from the contract rather than repeated.
 *
 * @remarks `SecuritySignalRaised` fills a `SecurityEventPayload` with a `SecuritySignalType`, so
 * the two lists cannot drift without a compile error here — at `security-signal.aggregate.ts`,
 * not at runtime. That is why this file exports the contract's union rather than asserting
 * equality by hand: a hand-written assertion would itself be a thing that has to be updated.
 */
export type PublishedSignalType = SecurityEventPayload['type'];