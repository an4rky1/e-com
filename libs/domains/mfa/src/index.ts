/**
 * @fileoverview The public surface of `@auth/domains/mfa`.
 *
 * @remarks The barrel is deliberately explicit rather than `export *`: a consumer importing
 * from here should be able to see, in one screen, the whole contract this service offers —
 * and a wildcard would quietly widen it every time a helper is added under `src/`.
 */

// ---- configuration -------------------------------------------------------------
export {
  Defaults,
  enrollmentTtlMs,
  mfaSchema,
  resolveMfaConfig,
  toPolicy,
  MFA_CONFIG,
  MFA_PRISMA,
  MFA_SECRET_ENCRYPTION_KEY,
  MFA_TOTP_DIGITS,
  MFA_TOTP_PERIOD_SEC,
  type MfaConfig,
  type MfaEnvConfig,
} from './mfa.config';

// ---- commands ------------------------------------------------------------------
export {
  BeginEnrollmentCommand,
  ConfirmEnrollmentCommand,
  DisableMfaCommand,
  RegenerateRecoveryCodesCommand,
  VerifyFactorCommand,
  toBeginEnrollmentCommand,
  toFactorSummary,
  type EnrollmentSecretBundle,
  type FactorVerificationResult,
  type MfaFactorSummary,
  type RecoveryCodeBundle,
} from './application/commands/mfa.commands';
export {
  BeginEnrollmentHandler,
  ConfirmEnrollmentHandler,
  DisableMfaHandler,
  RegenerateRecoveryCodesHandler,
  VerifyFactorHandler,
} from './application/commands/mfa.handlers';

// ---- queries -------------------------------------------------------------------
export {
  GetMfaStatusHandler,
  GetMfaStatusQuery,
  type MfaFactorStatus,
  type MfaRecoveryCodeStatus,
  type MfaStatusReadModel,
} from './application/queries/mfa.queries';

// ---- application ---------------------------------------------------------------
export { MfaService } from './application/facade/mfa.service';
export {
  toAppException,
  toMissingFactorException,
} from './application/errors/mfa-error-translation';

// ---- domain --------------------------------------------------------------------
export {
  MFA_FACTOR_AGGREGATE,
  MfaDisabled,
  MfaEnrollmentStarted,
  MfaEnrolled,
  MfaFactor,
  MfaVerificationFailed,
  MfaVerified,
  isMfaFactorEvent,
  type MfaFactorEvent,
  type MfaFactorProps,
  type MfaFactorRow,
} from './domain/mfa-factor.aggregate';
export {
  RECOVERY_CODE_SET_AGGREGATE,
  MfaRecoveryCodeVerified,
  MfaRecoveryCodesIssued,
  MfaRecoveryCodesRegenerated,
  RecoveryCodeSet,
  isRecoveryCodeSetEvent,
  type RecoveryCodeEntry,
  type RecoveryCodeSetEvent,
  type RecoveryCodeSetRow,
} from './domain/recovery-code-set.aggregate';
export {
  MfaDomainError,
  MfaErrorReason,
  isMfaDomainError,
} from './domain/errors/mfa-domain.error';
export { DEFAULT_POLICY, type MfaPolicy } from './domain/mfa-policy';
export {
  ENROLLMENT_TRANSITIONS,
  MfaStatus,
  VERIFIABLE_STATUSES,
  canTransition,
  isMfaStatus,
} from './domain/value-objects/mfa-status.vo';
export {
  ENROLLABLE_METHODS,
  MFA_METHODS,
  MfaMethod,
  RECOVERY_CODE_PATTERN,
  TOTP_ALGORITHM,
  TOTP_CODE_PATTERN,
  TOTP_DIGITS,
  TOTP_OTP_LABEL,
  TOTP_PERIOD_SEC,
  TOTP_WINDOW,
  isMfaMethod,
} from './domain/value-objects/mfa-method.vo';
export {
  BASE32_ALPHABET,
  REDACTED_SECRET,
  TOTP_SECRET_BYTES,
  TOTP_SECRET_PATTERN,
  TotpSecret,
} from './domain/value-objects/totp-secret.vo';
export {
  MFA_FACTOR_ID_PATTERN,
  MfaFactorIdOf,
  type MfaFactorId,
} from './domain/value-objects/mfa-factor-id.vo';

// ---- ports ---------------------------------------------------------------------
export {
  MFA_FACTOR_REPOSITORY,
  type MfaFactorRepositoryPort,
} from './domain/ports/mfa-factor-repository.port';
export {
  RECOVERY_CODE_SET_REPOSITORY,
  type RecoveryCodeSetRepositoryPort,
} from './domain/ports/recovery-code-set-repository.port';
export {
  CLOCK,
  MFA_UNIT_OF_WORK,
  type MfaClock,
  type MfaUnitOfWork,
} from './domain/ports/mfa-unit-of-work.port';
export {
  RECOVERY_CODES,
  type RecoveryCodePort,
} from './domain/ports/recovery-code.port';
export {
  SECRET_VAULT,
  type SecretVaultPort,
} from './domain/ports/secret-vault.port';
export {
  TOTP_ENGINE,
  type TotpEnginePort,
  type TotpMatch,
} from './domain/ports/totp.port';
export {
  MFA_CHALLENGE,
  type MfaChallengePort,
} from './domain/ports/mfa-challenge.port';

// ---- infrastructure ------------------------------------------------------------
export {
  NodeTotpService,
  base32Decode,
  base32Encode,
  counterAt,
  hotp,
} from './infrastructure/crypto/node-totp.service';
export {
  NodeRecoveryCodeService,
  RECOVERY_CODE_CHARS_PER_HALF,
  RECOVERY_CODE_SALT_BYTES,
  canonicalRecoveryCode,
} from './infrastructure/crypto/node-recovery-codes.service';
export {
  AES_KEY_BYTES,
  AesGcmSecretVault,
  ENVELOPE_VERSION,
  parseEncryptionKey,
} from './infrastructure/crypto/aes-gcm-secret-vault';
export { FixedClock, SystemClock } from './infrastructure/time/system-clock';
export { PrismaMfaFactorRepository } from './infrastructure/persistence/prisma-mfa-factor.repository';
export { PrismaRecoveryCodeSetRepository } from './infrastructure/persistence/prisma-recovery-code-set.repository';
export { PrismaMfaUnitOfWork } from './infrastructure/persistence/prisma-mfa-unit-of-work';
export {
  TOPIC_BY_EVENT,
  enqueueEvents,
  type EnqueueableEvent,
  type EnqueueOptions,
} from './infrastructure/persistence/outbox-enqueue';

// ---- presentation --------------------------------------------------------------
export { MfaController } from './presentation/mfa.controller';
export { MfaGuard, type MfaPrincipal } from './presentation/guards/mfa.guard';
export { SKIP_MFA, SkipMfa } from './presentation/decorators/skip-mfa.decorator';
export {
  BeginEnrollmentRequestDto,
  ConfirmEnrollmentRequestDto,
  DisableMfaRequestDto,
  EnrollmentSecretResponseDto,
  FactorVerificationResponseDto,
  MfaFactorResponseDto,
  MfaStatusResponseDto,
  RecoveryCodeResponseDto,
  RegenerateRecoveryCodesRequestDto,
  VerifyFactorRequestDto,
  toEnrollmentSecretResponse,
  toFactorResponse,
  toMfaStatusResponse,
  toRecoveryCodeResponse,
  toVerificationResponse,
} from './presentation/dto/mfa.dto';

// ---- module --------------------------------------------------------------------
export { MfaModule, createMfaModule } from './mfa.module';
export { MfaHealthIndicator } from './mfa.health';