/**
 * @fileoverview The device fingerprint.
 *
 * @remarks A fingerprint answers one question — "is this the same browser and machine as last
 * time?" — and it has to answer it *deterministically*: the same signals in, the same 64 hex
 * characters out, on every node, forever. That is why it is a SHA-256 over a canonical string
 * rather than anything clever: a scheme that drifts between deployments would make every user
 * look like they signed in from a new device.
 *
 * @remarks It is a hash and not the raw signals on purpose. The inputs describe the user's
 * hardware and software in enough detail to be identifying, `login_history.fingerprint` is
 * indexed on `(user_id, fingerprint)`, and the table outlives the session. Storing a digest
 * keeps the index useful and the raw user agent out of every backup of the database.
 */
import { createHash } from 'node:crypto';
import { ValueObject } from '@auth/core';

/**
 * The device attributes the fingerprint is derived from.
 *
 * @remarks Every field is optional because every one of them is missing for someone: a client
 * that sends no screen resolution, an old browser with no `navigator.language`, a gateway that
 * cannot see the UA at all. A missing signal contributes a stable empty component rather than
 * failing the request — refusing to score a login because the caller sent less telemetry would
 * turn "we know less" into "no protection at all".
 */
export interface DeviceSignals {
  readonly userAgent?: string | null;
  readonly platform?: string | null;
  readonly screenResolution?: string | null;
  readonly timezone?: string | null;
  readonly language?: string | null;
}

/**
 * The signals in the one order they are hashed in.
 *
 * @remarks Fixed order, never sorted at call time. A `Record` iterated with `Object.keys` would
 * order by insertion, which is whatever order the transport happened to build the object in;
 * the same device would then hash two different ways and the user would be "new" on alternate
 * sign-ins. The order is part of the algorithm, so it is a module constant and not a detail.
 */
const HASHED_FIELDS = [
  ['userAgent', 'ua'],
  ['platform', 'pf'],
  ['screenResolution', 'sr'],
  ['timezone', 'tz'],
  ['language', 'ln'],
] as const satisfies readonly (readonly [keyof DeviceSignals, string])[];

/** Separator between components; ASCII unit separator, which cannot appear in a UA string. */
const FIELD_SEPARATOR = '\u001f';
const COMPONENT_SEPARATOR = '\u001e';

/**
 * Collapses a raw signal into the form that is hashed.
 *
 * @remarks Case-folded and whitespace-collapsed because both vary without the device changing:
 * `Linux; X11` and `linux;  x11` are the same machine, and a user agent that picks up an extra
 * space when the browser version rolls over must not mint a new fingerprint.
 */
export function normaliseDeviceSignal(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The exact string the digest is taken over.
 *
 * @remarks Exported so a test can assert that two differently-cased inputs canonicalise to the
 * same bytes, rather than only that they collide after hashing. It is also what makes the
 * fingerprint *checkable*: given a digest and a claim about the device, anyone can recompute.
 */
export function canonicaliseDeviceSignals(signals: DeviceSignals): string {
  return HASHED_FIELDS.map(([field, label]) => {
    const component = normaliseDeviceSignal(signals[field]);
    return `${label}${COMPONENT_SEPARATOR}${component}`;
  }).join(FIELD_SEPARATOR);
}

export class DeviceFingerprint extends ValueObject<{ value: string }> {
  private constructor(value: string) {
    super({ value });
  }

  /**
   * Derives the fingerprint for a set of device signals.
   *
   * @remarks Synchronous on purpose. It is a pure function of its input, called once per login,
   * and an async API would make every caller in the scoring path await a constant.
   */
  static compute(signals: DeviceSignals): DeviceFingerprint {
    return new DeviceFingerprint(
      createHash('sha256').update(canonicaliseDeviceSignals(signals), 'utf8').digest('hex'),
    );
  }

  /**
   * Rehydration path: a fingerprint supplied by a caller that already computed one.
   *
   * @remarks Validated rather than trusted. `device_fingerprint` arrives over gRPC from
   * auth-gateway, and an unvalidated string in an indexed column is both an index-size problem
   * and an invitation to make one account's "devices" collide with another's.
   */
  static fromValue(value: string): DeviceFingerprint {
    return new DeviceFingerprint(value.trim().toLowerCase());
  }

  /** Rehydration from storage: the row is trusted, so an unusual-but-stored digest is kept. */
  static fromStored(value: string): DeviceFingerprint {
    return new DeviceFingerprint(value);
  }

  /** The lower-cased digest. Lower-cased so `WHERE fingerprint = ?` is index-usable. */
  get value(): string {
    return this.props.value;
  }

  override toString(): string {
    return this.value;
  }
}