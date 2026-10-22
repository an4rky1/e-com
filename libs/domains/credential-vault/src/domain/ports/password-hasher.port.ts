/**
 * @fileoverview The password hashing port.
 *
 * @remarks The aggregate decides *whether* to rehash; the port decides *how*. That split is
 * what keeps `domain/` free of `argon2` — a native addon is an infrastructure concern, and a
 * domain model that imports one cannot be unit-tested without a compiled binary.
 */

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/** Argon2 version 1.3 — the current one, and the only one `argon2id` encodes. */
export const ARGON2_VERSION = 0x13;

/**
 * Argon2id cost parameters.
 *
 * @remarks Persisted alongside every hash in `credentials.secret_parameters` so a later policy
 * bump can tell a hash that *needs* upgrading from one that is merely old. Storing only the
 * digest would make that distinction unknowable — the digest does not say what produced it.
 */
export interface HashParameters {
  algorithm: 'argon2id';
  /** KiB of memory. The dominant cost, and the term Argon2 was designed to defend. */
  memoryCost: number;
  /** Passes over memory. */
  timeCost: number;
  /** Lanes. More lanes cost more CPU for the same memory. */
  parallelism: number;
  /** Output length in bytes. */
  hashLength: number;
  /** Argon2 version, `0x13` for the current one. */
  version: number;
}

/** The result of hashing: the digest and the parameters that produced it. */
export interface PasswordHash {
  digest: string;
  parameters: HashParameters;
}

export interface PasswordHasherPort {
  /**
   * Hashes a password.
   *
   * @remarks Returns the parameters alongside the digest because the caller must persist
   * them: a hash nobody can reason about cannot be upgraded later.
   */
  hash(password: string): Promise<PasswordHash>;

  /**
   * Verifies a candidate against a stored digest.
   *
   * @remarks Never throws for a mismatch — a wrong password is the expected case, not an
   * error. Malformed input must also answer `false` rather than raise, because the digest
   * comes from a database that an operator can put anything in.
   */
  verify(digest: string, password: string): Promise<boolean>;

  /**
   * Spends one verification's worth of work on a password that has no credential.
   *
   * @remarks Argon2id is constant-time in the digest, not in the *absence* of one: a request
   * for an unknown user returns in microseconds while a real one takes tens of milliseconds,
   * and the gap is a free account-enumeration oracle over a long enough window. The only way
   * to close it is to actually do the work, which is what this does.
   */
  equaliseTiming(password: string): Promise<void>;

  /**
   * Whether `parameters` are weaker than what this instance hashes with today.
   *
   * @remarks True is the signal to rehash on the next successful verification. It never means
   * "hash is broken" — it means the stored cost is below current policy, which is a normal,
   * expected state after a configuration bump.
   */
  needsRehash(parameters: HashParameters): boolean;

  /** The parameters new hashes will carry. */
  readonly currentParameters: HashParameters;

  /**
   * Whether a pepper is mixed into every hash.
   *
   * @remarks Reported rather than assumed: with no pepper, a stolen digest table is an
   * offline-cracking target exactly as Argon2 is designed to be.
   */
  readonly peppered: boolean;
}