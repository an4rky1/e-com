/**
 * @fileoverview Transport shapes for the MFA endpoints.
 *
 * @remarks DTOs, not aggregate projections. The classes describe what a client may *send*;
 * the responses are built by pure mappers from the read models, so a field added to the
 * aggregate for internal reasons cannot leak onto the wire by accident.
 *
 * @remarks Codes are validated for *shape*, never for value. A `Matches` on six digits is
 * cheap to reject at the edge; it says nothing about whether the code is correct, and the
 * distinction matters — a wrong code and a malformed one must not be two different answers.
 */

import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  RECOVERY_CODE_PATTERN,
  TOTP_CODE_PATTERN,
} from '../../domain/value-objects/mfa-method.vo';
import type { MfaStatusReadModel } from '../../application/queries/mfa.queries';
import type {
  EnrollmentSecretBundle,
  FactorVerificationResult,
  MfaFactorSummary,
  RecoveryCodeBundle,
} from '../../application/commands/mfa.commands';

export class BeginEnrollmentRequestDto {
  @IsOptional()
  @IsIn(['totp'])
  @MaxLength(32)
  method?: 'totp';

  /** What the authenticator app should call this factor, e.g. `Pixel 8`. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  accountLabel?: string;
}

export class ConfirmEnrollmentRequestDto {
  @IsString()
  @Matches(TOTP_CODE_PATTERN, { message: 'code must be six digits' })
  code!: string;
}

export class VerifyFactorRequestDto {
  @IsString()
  @Matches(/^[0-9]{6}$|^[A-Z2-7]{5}-[A-Z2-7]{5}$/, {
    message: 'code must be six digits or a recovery code',
  })
  code!: string;

  @IsOptional()
  @IsIn(['totp', 'backup_code'])
  method?: 'totp' | 'backup_code';

  /** Which factor to check. Omitted means the user's active factor for the method. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  factorId?: string;
}

export class DisableMfaRequestDto {
  @IsString()
  @Matches(TOTP_CODE_PATTERN, { message: 'code must be six digits' })
  code!: string;
}

export class RegenerateRecoveryCodesRequestDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  count?: number;
}

/**
 * The one response carrying a plaintext TOTP secret.
 *
 * @remarks Explicitly typed rather than spread from the aggregate, because the property that
 * matters — that the secret appears here and nowhere else — is a property of the *type*. A
 * `Record<string, unknown>` here would hide it.
 */
export class EnrollmentSecretResponseDto {
  factorId!: string;
  method!: string;
  secret!: string;
  otpauthUri!: string;
  issuer!: string;
  expiresAt!: string;
}

export class MfaFactorResponseDto {
  id!: string;
  userId!: string;
  method!: string;
  status!: string;
  accountLabel!: string | null;
  activatedAt!: string | null;
  lastVerifiedAt!: string | null;
  failedAttempts!: number;
  lockedUntil!: string | null;
  version!: number;
}

export class FactorVerificationResponseDto {
  userId!: string;
  method!: string;
  factorId!: string | null;
  counter!: string | null;
  verifiedAt!: string;
}

export class RecoveryCodeResponseDto {
  codes!: string[];
  count!: number;
  issuedAt!: string;
  regenerated!: boolean;
}

export class MfaStatusResponseDto {
  userId!: string;
  enrolled!: boolean;
  factors!: MfaFactorResponseDto[];
  activeFactorId!: string | null;
  pendingFactorId!: string | null;
  recoveryCodes!: { total: number; remaining: number } | null;
  lockedUntil!: string | null;
}

export const toEnrollmentSecretResponse = (
  bundle: EnrollmentSecretBundle,
): EnrollmentSecretResponseDto => ({
  factorId: bundle.factorId,
  method: bundle.method,
  secret: bundle.secret,
  otpauthUri: bundle.otpauthUri,
  issuer: bundle.issuer,
  expiresAt: bundle.expiresAt,
});

export const toFactorResponse = (factor: MfaFactorSummary): MfaFactorResponseDto => ({
  id: factor.id,
  userId: factor.userId,
  method: factor.method,
  status: factor.status,
  accountLabel: factor.accountLabel,
  activatedAt: factor.activatedAt,
  lastVerifiedAt: factor.lastVerifiedAt,
  failedAttempts: factor.failedAttempts,
  lockedUntil: factor.lockedUntil,
  version: factor.version,
});

export const toVerificationResponse = (
  result: FactorVerificationResult,
): FactorVerificationResponseDto => ({
  userId: result.userId,
  method: result.method,
  factorId: result.factorId,
  counter: result.counter,
  verifiedAt: result.verifiedAt,
});

export const toRecoveryCodeResponse = (
  bundle: RecoveryCodeBundle,
): RecoveryCodeResponseDto => ({
  codes: [...bundle.codes],
  count: bundle.count,
  issuedAt: bundle.issuedAt,
  regenerated: bundle.regenerated,
});

export const toMfaStatusResponse = (status: MfaStatusReadModel): MfaStatusResponseDto => ({
  userId: status.userId,
  enrolled: status.enrolled,
  factors: status.factors.map((factor) => toFactorResponse(factor)),
  activeFactorId: status.activeFactorId,
  pendingFactorId: status.pendingFactorId,
  recoveryCodes: status.recoveryCodes
    ? { total: status.recoveryCodes.total, remaining: status.recoveryCodes.remaining }
    : null,
  lockedUntil: status.lockedUntil,
});

export { RECOVERY_CODE_PATTERN };