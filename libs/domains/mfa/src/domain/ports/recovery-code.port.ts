/**
 * @fileoverview Recovery codes: generation, digesting and comparison.
 *
 * @remarks Three operations that look like one utility and are not. `generate` has to be
 * cryptographically random — `Math.random` there produces a set an attacker can predict from
 * one observed code, which is the same as shipping no backup codes at all. `digest` has to be
 * one-way, so that a dump of `mfa_recovery_codes` does not hand over the codes that are still
 * unused. `matches` has to be constant-time, so that comparing codes does not leak how many
 * leading characters were right.
 *
 * @remarks All three are behind one port because they share one source of entropy. Splitting
 * them would invite an implementation that generated codes with a weak PRNG while digesting
 * them correctly.
 */

export const RECOVERY_CODES = Symbol('RECOVERY_CODES');

export interface RecoveryCodePort {
  /** `count` fresh codes. Guaranteed distinct within the batch and CSPRNG-sourced. */
  generate(count: number): string[];

  /** A per-set salt. Stored on `mfa_recovery_code_sets.salt`, mixed into every digest. */
  newSalt(): string;

  /** SHA-256 over `salt` and `code`. The code itself is never stored. */
  digest(code: string, salt: string): string;

  /** Constant-time comparison of `code` against a stored digest. */
  matches(code: string, salt: string, digest: string): boolean;
}