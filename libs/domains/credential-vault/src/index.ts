export {
  VAULT_CONFIG,
  VAULT_PRISMA,
  Defaults as VaultDefaults,
  credentialVaultSchema,
  resolveCredentialVaultConfig,
  type CredentialVaultConfig,
  type CredentialVaultEnvConfig,
} from './credential-vault.config';
export { CredentialVaultModule, createCredentialVaultModule } from './credential-vault.module';
export {
  ChangePasswordCommand,
  RegenerateRecoveryCodesCommand,
  RevokeAllCredentialsCommand,
  SetPasswordCommand,
  VerifyPasswordCommand,
  toChangePasswordCommand,
  toRegenerateRecoveryCodesCommand,
  toRevokeAllCredentialsCommand,
  toSetPasswordCommand,
  toVerifyPasswordCommand,
  type PasswordVerification,
} from './application/commands/credential.commands';
export {
  ChangePasswordHandler,
  INVALID_CREDENTIALS_MESSAGE,
  RegenerateRecoveryCodesHandler,
  RevokeAllCredentialsHandler,
  SetPasswordHandler,
  VerifyPasswordHandler,
} from './application/commands/credential.handlers';
export {
  GetCredentialStatusHandler,
  GetCredentialStatusQuery,
  toCredentialStatusReadModel,
  type CredentialStatusReadModel,
} from './application/queries/credential.queries';
export { CredentialVaultService } from './application/facade/credential-vault.service';
export {
  CREDENTIAL_AGGREGATE,
  CredentialFailed,
  CredentialRevoked,
  CredentialRotated,
  CredentialRotation,
  CredentialVerified,
  DEFAULT_CREDENTIAL_IDENTIFIER,
  FAILED_ATTEMPTS_LOCK_REASON,
  PasswordCredential,
  isCredentialEvent,
  type CredentialEvent,
  type LockoutPolicy,
  type PasswordCredentialProps,
  type PasswordCredentialRow,
} from './domain/password-credential.aggregate';
export {
  RECOVERY_CODE_SET_AGGREGATE,
  RecoveryCodeSet,
  RecoveryCodesRegenerated,
  isRecoveryCodeEvent,
  type RecoveryCodeEvent,
} from './domain/recovery-code-set.aggregate';
export {
  CREDENTIAL_REPOSITORY,
  CredentialSpecification,
  LiveCredentials,
  VerifiableCredentials,
  type CredentialRepositoryPort,
} from './domain/ports/credential-repository.port';
export {
  ARGON2_VERSION,
  PASSWORD_HASHER,
  type HashParameters,
  type PasswordHash,
  type PasswordHasherPort,
} from './domain/ports/password-hasher.port';
export { CredentialId } from './domain/value-objects/credential-id.vo';
export {
  CredentialMethod,
  CredentialStatus,
  TERMINAL_STATUSES,
  VERIFIABLE_STATUSES,
  isCredentialStatus,
} from './domain/value-objects/credential-status.vo';
export {
  COMMON_PASSWORDS,
  PASSWORD_ACCEPTED,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH_FLOOR,
  PASSWORD_REJECTED_MESSAGE,
  PasswordPolicy,
  PasswordPolicyViolation,
  type PasswordPolicyRules,
} from './domain/value-objects/password-policy.vo';
export {
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_COUNT_DEFAULT,
  RECOVERY_CODE_COUNT_MAX,
  RECOVERY_CODE_DIGEST_LENGTH,
  RecoveryCode,
  isValidRecoveryCodeCount,
  toDigestRows,
  type RecoveryCodeRow,
} from './domain/value-objects/recovery-code.vo';
export { PrismaCredentialRepository } from './infrastructure/persistence/prisma-credential.repository';
export {
  Argon2PasswordHasher,
  applyPepper,
  type Argon2Options,
} from './infrastructure/security/argon2-password.hasher';
export { CredentialVaultGrpcController } from './presentation/grpc/credential-vault.grpc.controller';