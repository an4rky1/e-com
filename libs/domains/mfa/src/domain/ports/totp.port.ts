/**
 * @fileoverview RFC 6238 generation and verification, as a port.
 *
 * @remarks Why this is a port and not a call to a library: TOTP is arithmetic over a key, and
 * the aggregate needs the answer to "does this code match, and at which time step?" — not a
 * dependency on an HMAC primitive. That keeps `domain/` free of `node:crypto` (the layering
 * rule, enforced by lint) and lets the suite drive verification from a fixed clock with the
 * *production* implementation, rather than from a stub that agrees with whatever the
 * aggregate happens to do.
 */

export const TOTP_ENGINE = Symbol('TOTP_ENGINE');

/** What a match carries back: the time step the code belongs to. */
export interface TotpMatch {
  /** The accepted counter. Replay protection is keyed on exactly this number. */
  readonly counter: bigint;
  /** How far from the current step the match was. 0 is the current step. */
  readonly drift: number;
}

export interface TotpEnginePort {
  /** A fresh base32 secret. */
  generateSecret(): string;

  /**
   * The codes that would be accepted right now.
   *
   * @remarks Exposed so an enrollment screen can show the user the authenticator is working
   * without ever asking the aggregate to store a plaintext secret.
   */
  currentCode(secret: string, at: Date): string;

  /**
   * Verifies `code` against `secret`, tolerating `window` steps of skew either way.
   *
   * @remarks Returns `null` rather than `false`. The counter is what makes a match
   * distinguishable from a *replay* of a match — the caller needs the step, not a verdict.
   */
  verify(input: {
    readonly secret: string;
    readonly code: string;
    readonly at: Date;
    readonly window: number;
  }): TotpMatch | null;
}