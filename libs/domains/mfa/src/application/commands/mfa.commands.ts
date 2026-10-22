/**
 * @fileoverview The five write intents of this service.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in presentation. Keeping them apart means renaming a REST field never
 * reaches the domain.
 *
 * @remarks A class, not an interface. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is given —
 * `@CommandHandler('Name')` throws at import, because `Reflect.hasOwnMetadata` rejects a
 * non-object. `Command<R>` still carries the result type, so the bus call stays as
 * type-checked as an interface would have been.
 *
 * @remarks No command accepts a secret or a pre-hashed code from the caller. The server mints
 * the secret, encrypts it and digests codes; a caller who could choose either would be able
 * to enrol a factor whose secret anyone else can compute.
 */

import { Command } from '@nestjs/cqrs';
import type { MfaMethod } from '../../domain/value-objects/mfa-method.vo';
import type { MfaStatus } from '../../domain/value-objects/mfa-status.vo';

/** What an enrollment hands back — the one response that carries a plaintext secret. */
export interface EnrollmentSecretBundle {
  readonly factorId: string;
  readonly method: MfaMethod;
  /** RFC 4648 base32. Shown once; the stored form is an AES-256-GCM envelope. */
  readonly secret: string;
  /** The `otpauth://` URI an authenticator app scans. */
  readonly otpauthUri: string;
  readonly issuer: string;
  /** When the confirmation window closes, ISO-8601. */
  readonly expiresAt: string;
}

/** Projection of a factor for callers. Never carries the secret in any form. */
export interface MfaFactorSummary {
  readonly id: string;
  readonly userId: string;
  readonly method: MfaMethod;
  readonly status: MfaStatus;
  readonly accountLabel: string | null;
  readonly activatedAt: string | null;
  readonly lastVerifiedAt: string | null;
  readonly failedAttempts: number;
  readonly lockedUntil: string | null;
  readonly version: number;
}

/** A successful second-factor check. */
export interface FactorVerificationResult {
  readonly userId: string;
  readonly method: MfaMethod;
  readonly factorId: string | null;
  /** The TOTP step that was spent. `null` for a recovery code. ISO-safe as a string. */
  readonly counter: string | null;
  readonly verifiedAt: string;
}

/** The one response that carries recovery codes in the clear. */
export interface RecoveryCodeBundle {
  readonly codes: readonly string[];
  readonly count: number;
  readonly issuedAt: string;
  readonly regenerated: boolean;
}

// ---- enrollment ----------------------------------------------------------------

export class BeginEnrollmentCommand extends Command<EnrollmentSecretBundle> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly method: MfaMethod = 'totp',
    readonly accountLabel?: string | null,
    readonly destinationHint?: string | null,
  ) {
    super();
  }
}

export const toBeginEnrollmentCommand = (input: {
  userId: string;
  method?: MfaMethod;
  accountLabel?: string | null;
  destinationHint?: string | null;
}): BeginEnrollmentCommand =>
  new BeginEnrollmentCommand(
    input.userId,
    input.method ?? 'totp',
    input.accountLabel ?? null,
    input.destinationHint ?? null,
  );

export class ConfirmEnrollmentCommand extends Command<MfaFactorSummary> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly factorId: string,
    /** The code the authenticator app is showing right now. Never logged, never stored. */
    readonly code: string,
  ) {
    super();
  }
}

// ---- verification --------------------------------------------------------------

/**
 * Checks a second factor.
 *
 * @remarks Two methods on one command rather than two commands, because from the caller's
 * point of view they are one question with two answers available, and the *choice* between a
 * code from an authenticator and a code from a printed sheet is a property of the proof the
 * user happens to have — not a different business operation.
 */
export class VerifyFactorCommand extends Command<FactorVerificationResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly code: string,
    readonly method: MfaMethod = 'totp',
    /** Which factor to check. Omitted means "the user's active factor for this method". */
    readonly factorId?: string,
  ) {
    super();
  }
}

// ---- revocation ----------------------------------------------------------------

export class DisableMfaCommand extends Command<void> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly factorId: string,
    /** Proof of the factor being revoked — see the aggregate's `disable` for why. */
    readonly code: string,
  ) {
    super();
  }
}

export class RegenerateRecoveryCodesCommand extends Command<RecoveryCodeBundle> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    /** Overrides `MFA_RECOVERY_CODE_COUNT`. Bounded by the schema's maximum. */
    readonly count?: number,
  ) {
    super();
  }
}

export const toFactorSummary = (factor: {
  id: string;
  userId: string;
  method: MfaMethod;
  status: MfaStatus;
  accountLabel: string | null;
  activatedAt: Date | null;
  lastVerifiedAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  factorVersion: number;
}): MfaFactorSummary => ({
  id: factor.id,
  userId: factor.userId,
  method: factor.method,
  status: factor.status,
  accountLabel: factor.accountLabel,
  activatedAt: factor.activatedAt?.toISOString() ?? null,
  lastVerifiedAt: factor.lastVerifiedAt?.toISOString() ?? null,
  failedAttempts: factor.failedAttempts,
  lockedUntil: factor.lockedUntil?.toISOString() ?? null,
  version: factor.factorVersion,
});