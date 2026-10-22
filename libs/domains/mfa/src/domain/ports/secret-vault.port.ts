/**
 * @fileoverview Encryption at rest for factor secrets.
 *
 * @remarks A port, not a helper function, and the seam is deliberate. `mfa_factors.secret_
 * ciphertext` holds a value that is worthless once the key is gone, so the real question is
 * not "which AES mode" but "can the key live somewhere other than this process". A KMS or an
 * HSM satisfies this interface unchanged; the domain never learns which one is bound.
 *
 * @remarks Asynchronous even though AES-GCM over `node:crypto` is synchronous. That is the
 * shape the remote implementations have, and a port that returned a string would have to be
 * widened the day someone swapped the local cipher for one — breaking every caller at once.
 */

export const SECRET_VAULT = Symbol('SECRET_VAULT');

export interface SecretVaultPort {
  /**
   * Returns an opaque, self-describing ciphertext.
   *
   * @remarks The envelope carries its own version so a key rotation can decrypt the old
   * format instead of failing opaquely months later.
   */
  encrypt(plaintext: string): Promise<string>;

  /** Throws rather than returning a sentinel: a corrupt envelope is not a recoverable state. */
  decrypt(ciphertext: string): Promise<string>;
}