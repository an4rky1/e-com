import { Result } from '../results/result';

/**
 * Why a dedicated type: the domain should never hold a raw, casing-mangled string as an
 * email. Normalising at construction means every downstream comparison is a plain string
 * equality check, and validation cannot be forgotten at one of five call sites.
 */

// Deliberately conservative: `local@domain` is technically valid but never a real mailbox.
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

const MAX_EMAIL_LENGTH = 254;

export class Email {
  private constructor(public readonly value: string) {}

  static create(raw: string): Result<Email, string> {
    if (typeof raw !== 'string') {
      return Result.fail('email must be a string');
    }

    // Case-insensitivity on the local part is technically wrong per RFC, but every major
    // provider treats it that way and splitting Bob@x.com from bob@x.com duplicates users.
    const normalised = raw.trim().toLowerCase();

    if (normalised.length === 0 || normalised.length > MAX_EMAIL_LENGTH) {
      return Result.fail('email length is out of range');
    }

    if (!EMAIL_PATTERN.test(normalised)) {
      return Result.fail('email has an invalid format');
    }

    return Result.ok(new Email(normalised));
  }

  /** For trusted paths where a malformed value is a programming error, not user input. */
  static fromTrusted(raw: string): Email {
    return Email.create(raw).unwrapOrThrow();
  }

  static isValid(raw: unknown): boolean {
    return typeof raw === 'string' && Email.create(raw).isSuccess;
  }

  get domain(): string {
    return this.value.slice(this.value.lastIndexOf('@') + 1);
  }

  /**
   * Redacted form for logs and audit entries — a single leaked log line must not
   * enumerate live mailboxes.
   */
  get obfuscated(): string {
    const at = this.value.lastIndexOf('@');
    const local = this.value.slice(0, at);
    const domain = this.value.slice(at + 1);
    return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
  }

  equals(other: Email): boolean {
    return other instanceof Email && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}