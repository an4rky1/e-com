/**
 * @fileoverview Storage ports for account-security.
 *
 * @remarks Declared in the domain and implemented with Prisma so the application layer can be
 * unit-tested against a plain object. There is no specification base class here, unlike
 * credential-vault: this service has two tables and every read is an explicit, named question
 * ("what does this account's history look like", "where was it last seen"), so a predicate
 * interface over an entity would add a layer that describes nothing.
 */
import type { LoginAttempt } from '../login-attempt.aggregate';
import type { SecuritySignal, SecuritySignalRow } from '../security-signal.aggregate';
import type { DeviceSignals } from '../value-objects/device-fingerprint.vo';
import type { GeoLocation } from '../value-objects/geo-location.vo';

export const SECURITY_REPOSITORY = Symbol('SECURITY_REPOSITORY');

/** How a device was last seen. The projection `ListDevices` renders. */
export interface DeviceUsage {
  /** The fingerprint. Stable, opaque, and the id `RevokeDevice` takes. */
  readonly fingerprint: string;
  readonly lastSeenAt: Date;
  readonly location: GeoLocation | null;
  readonly sessionId: string | null;
  /** False once `RevokeDevice` has retired it. */
  readonly trusted: boolean;
  /** Number of logins recorded from this fingerprint. */
  readonly loginCount: number;
  /** The signals that carried the device's raw attributes, when one has been raised. */
  readonly signals: DeviceSignals | null;
}

/** One row of `login_history`, as the read side needs it. */
export interface LoginHistoryEntry {
  readonly loginId: string;
  readonly sessionId: string | null;
  readonly fingerprint: string;
  readonly country: string | null;
  readonly location: GeoLocation | null;
  readonly occurredAt: Date;
}

export interface SecurityRepositoryPort {
  /**
   * Writes the attempt's row, its signals and their outbox rows in one transaction.
   *
   * @remarks One method rather than `save` called twice. The guarantee is transactional-outbox:
   * either the login history and the events that describe it both exist, or neither does.
   * Committing the history first and failing on the events leaves an attack that was recorded
   * and never announced, and no consumer would ever learn to look.
   *
   * @remarks A failed attempt contributes no `login_history` row — see
   * {@link LoginAttempt.toRow} — so this may write signals alone.
   */
  saveAttempt(attempt: LoginAttempt, signals: readonly SecuritySignal[]): Promise<void>;

  /**
   * Writes signals and their outbox rows in one transaction.
   *
   * @remarks Used by the commands that mutate without a login — lock, unlock, revoke. Same
   * reason as above: an announced fact with no row, or a row nobody was told about.
   */
  saveSignals(signals: readonly SecuritySignal[]): Promise<void>;

  /** An account's logins, newest first. */
  listLoginHistory(
    userId: string,
    options?: { limit?: number },
  ): Promise<readonly LoginHistoryEntry[]>;

  /**
   * Every fingerprint this account has signed in from, newest first.
   *
   * @remarks Derived from `login_history` rather than from a devices table, so it survives a
   * cache flush and so a device nobody has used in a year is still listed — which is the whole
   * point of a "sign out everywhere" screen.
   */
  listDevices(userId: string): Promise<readonly DeviceUsage[]>;

  /**
   * Where this account was last seen, excluding one fingerprint.
   *
   * @remarks Excluding the current device is not a detail. Comparing a login against the
   * previous login *from the same laptop* would produce "travel distance 0" every time and the
   * impossible-travel factor would never fire for the device a user actually travels with.
   *
   * @returns `null` for a first login, or when every prior login has no coordinates.
   */
  lastSeenElsewhere(
    userId: string,
    fingerprint: string,
  ): Promise<{ location: GeoLocation; occurredAt: Date } | null>;

  /** UTC hours of day this account has logged in at, newest first, for the "unusual hour" factor. */
  recentLoginHours(userId: string, limit: number): Promise<readonly number[]>;

  /** Signals raised for an account, newest first. */
  listSignals(
    userId: string,
    options?: { limit?: number },
  ): Promise<readonly SecuritySignalRow[]>;
}

/**
 * The known-device registry.
 *
 * @remarks Split from the repository because it answers a different kind of question and has
 * different durability. `login_history` says what *happened* and is never rewritten; this
 * remembers what has been *decided* — that a device is trusted, or that an operator retired it
 * — and the decision is what lets a revocation survive.
 *
 * @remarks Redis-backed. A revocation that only existed in a request would be forgotten the
 * moment the response was sent, and a device the user retired would quietly come back on their
 * next sign-in.
 */
export const DEVICE_REGISTRY = Symbol('DEVICE_REGISTRY');

export interface DeviceRegistryPort {
  /** Whether this account has signed in from this fingerprint before. */
  isKnown(userId: string, fingerprint: string): Promise<boolean>;

  /** Whether this fingerprint has been explicitly retired. */
  isRevoked(userId: string, fingerprint: string): Promise<boolean>;

  /**
   * Records that a fingerprint is this account's device.
   *
   * @remarks Only ever called on a successful login. Remembering a device that never signed in
   * would mean one attacker-supplied fingerprint gets to pre-claim the "new device" signal and
   * suppress it for the real owner.
   */
  remember(userId: string, fingerprint: string): Promise<void>;

  /** Retires a fingerprint for an account. Idempotent. */
  revoke(userId: string, fingerprint: string): Promise<void>;
}