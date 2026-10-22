/**
 * @fileoverview Handlers for the credential commands.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means changing a REST
 * field name never reaches the domain.
 *
 * @remarks A class, not an interface. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is given.
 * A plain object or a string key therefore cannot dispatch at all — `@CommandHandler('Name')`
 * throws at import, because `Reflect.hasOwnMetadata` rejects a non-object.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  InvalidCredentialsException,
  ValidationException,
} from '@auth/platform/error-handling';
import { VAULT_CONFIG, type CredentialVaultConfig } from '../../credential-vault.config';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepositoryPort,
} from '../../domain/ports/credential-repository.port';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../../domain/ports/password-hasher.port';
import {
  CredentialRotation,
  PasswordCredential,
  type LockoutPolicy,
} from '../../domain/password-credential.aggregate';
import { RecoveryCodeSet } from '../../domain/recovery-code-set.aggregate';
import {
  PASSWORD_REJECTED_MESSAGE,
  PasswordPolicy,
  type PasswordPolicyViolation,
} from '../../domain/value-objects/password-policy.vo';
import {
  isValidRecoveryCodeCount,
  type RecoveryCode,
} from '../../domain/value-objects/recovery-code.vo';
import {
  ChangePasswordCommand,
  RegenerateRecoveryCodesCommand,
  RevokeAllCredentialsCommand,
  SetPasswordCommand,
  VerifyPasswordCommand,
  type PasswordVerification,
} from './credential.commands';

/**
 * The one message every refused verification carries.
 *
 * @remarks "Wrong password", "no such credential", "revoked" and "locked" are four different
 * facts about the caller, and a caller who can tell them apart can enumerate which ids hold
 * accounts. They are therefore collapsed into a single constant: the code path chooses what to
 * *log*, and this is what it is allowed to *say*.
 *
 * @remarks No exception built here carries a context object. `AppException` spreads its
 * context into the response body, so `failedAttempts: 4` on one branch and nothing on the
 * other would be the enumeration oracle even with an identical message string.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'invalid credentials';

/**
 * Refuses a password the policy will not accept.
 *
 * @remarks The violations travel in the exception's context because this failure is *not*
 * secret: the caller supplied the password, so telling them which rule it broke is the whole
 * point. This is the opposite trade to {@link INVALID_CREDENTIALS_MESSAGE}, and it is
 * deliberate rather than an inconsistency.
 */
function assertPasswordAccepted(policy: PasswordPolicy, password: string): void {
  const violations: readonly PasswordPolicyViolation[] = policy.evaluate(password);
  if (violations.length === 0) return;

  throw new ValidationException(PASSWORD_REJECTED_MESSAGE, { violations });
}

// ---- SetPassword ----------------------------------------------------------------

@Injectable()
@CommandHandler(SetPasswordCommand)
export class SetPasswordHandler implements ICommandHandler<SetPasswordCommand, string> {
  private readonly logger = new Logger(SetPasswordHandler.name);
  private readonly policy: PasswordPolicy;

  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(VAULT_CONFIG) private readonly config: CredentialVaultConfig,
  ) {
    this.policy = PasswordPolicy.of({ minLength: config.minPasswordLength });
  }

  /**
   * Installs a first password, or replaces one that already exists.
   *
   * @remarks This handler is *not* proof of possession: it takes the new secret and nothing
   * else. That is correct for the three callers that exist — registration (nobody holds a
   * password yet), an email-change reset and an operator recovery — but it means the caller
   * must have proved something by other means first. `ChangePasswordCommand` is the command
   * that demands the old secret, and a caller that means "this person knows their password"
   * must use that one.
   *
   * @remarks Replacing rather than creating a second row when one exists: two live password
   * credentials for one account means two `identifier` values that both authenticate, and
   * neither `revokeAll` nor "change my password" would have any way to describe the intent.
   */
  async execute(command: SetPasswordCommand): Promise<string> {
    assertPasswordAccepted(this.policy, command.newPassword);

    // The identifier names *which account* within a method — `method` already says "password".
    // Defaulting it to a method name put the literal "password" in the column, and the
    // database's partial unique index on (lower(identifier), method) then rejected the second
    // password ever set anywhere in the platform. Falling back to the user id keeps the
    // natural key stable and unique without needing an email lookup the vault does not own.
    const identifier = command.identifier?.trim() || command.userId;
    const existing = await this.credentials.findPasswordCredential(command.userId, identifier);
    const hash = await this.hasher.hash(command.newPassword);

    const credential =
      existing ??
      PasswordCredential.create({
        userId: command.userId,
        hasher: this.hasher,
        hash,
        identifier,
      });

    if (existing) {
      existing.replaceSecret(hash, CredentialRotation.CHANGED);
      this.logger.log(`replaced the existing password credential for ${identifier}`);
    }

    await this.credentials.save(credential);
    return credential.id.value;
  }
}

// ---- ChangePassword -------------------------------------------------------------

@Injectable()
@CommandHandler(ChangePasswordCommand)
export class ChangePasswordHandler
  implements ICommandHandler<ChangePasswordCommand, string>
{
  private readonly logger = new Logger(ChangePasswordHandler.name);
  private readonly policy: PasswordPolicy;

  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(VAULT_CONFIG) private readonly config: CredentialVaultConfig,
  ) {
    this.policy = PasswordPolicy.of({ minLength: config.minPasswordLength });
  }

  /**
   * Rotates the secret, but only for someone who can present the old one.
   *
   * @remarks A wrong current password is recorded as a failed attempt and *then* refused with
   * the shared message. Recording it is not optional: without the `credential.failed` event
   * there is no signal that someone is guessing, and without the counter a rate limiter has
   * nothing to count.
   */
  async execute(command: ChangePasswordCommand): Promise<string> {
    const credential = await this.credentials.findPasswordCredential(command.userId);

    if (!credential) {
      await this.hasher.equaliseTiming(command.currentPassword);
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }
    if (!credential.isVerifiable()) {
      this.logger.warn(`change refused for ${command.userId}: credential is not verifiable`);
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    const matches = await this.hasher.verify(credential.digest, command.currentPassword);
    if (!matches) {
      credential.recordFailure(this.lockoutPolicy());
      await this.credentials.save(credential);
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    assertPasswordAccepted(this.policy, command.newPassword);

    const hash = await this.hasher.hash(command.newPassword);
    credential.replaceSecret(hash, CredentialRotation.CHANGED);

    await this.credentials.save(credential);
    return credential.id.value;
  }

  private lockoutPolicy(): LockoutPolicy {
    return {
      maxFailedAttempts: this.config.maxFailedAttempts,
      lockoutSec: this.config.lockoutSec,
    };
  }
}

// ---- VerifyPassword -------------------------------------------------------------

@Injectable()
@CommandHandler(VerifyPasswordCommand)
export class VerifyPasswordHandler
  implements ICommandHandler<VerifyPasswordCommand, PasswordVerification>
{
  private readonly logger = new Logger(VerifyPasswordHandler.name);

  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(VAULT_CONFIG) private readonly config: CredentialVaultConfig,
  ) {}

  /**
   * The whole service, in one method: "prove you are this user".
   *
   * @remarks Every refusal below throws the *same* exception with the *same* message, and the
   * branch that refused is written to the log instead. The caller learns only that the proof
   * failed, which is the only fact they were entitled to.
   *
   * @remarks The unknown-user branch burns an Argon2 budget on a password that has no
   * credential. That work is not pointless — it is what stops the response-time difference
   * between "no such user" and "wrong password" from being the oracle that
   * {@link INVALID_CREDENTIALS_MESSAGE} exists to close.
   */
  async execute(command: VerifyPasswordCommand): Promise<PasswordVerification> {
    const now = new Date();
    const credential = await this.credentials.findPasswordCredential(
      command.userId,
      command.identifier,
    );

    if (!credential) {
      await this.hasher.equaliseTiming(command.password);
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    if (credential.isRevoked()) {
      this.logger.warn(`verification refused for ${command.userId}: credential is revoked`);
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    if (credential.isLocked(now)) {
      this.logger.warn(
        `verification refused for ${command.userId}: locked for another ` +
          `${credential.retryAfterSeconds(now)}s`,
      );
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    const matches = await this.hasher.verify(credential.digest, command.password);

    if (!matches) {
      credential.recordFailure(
        { maxFailedAttempts: this.config.maxFailedAttempts, lockoutSec: this.config.lockoutSec },
        now,
      );
      // The failure is persisted and announced before the exception leaves, so an attack is
      // visible to account-security even though the caller hears nothing.
      await this.credentials.save(credential);
      throw new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);
    }

    credential.recordVerification(now);

    // The transparent upgrade. Only reachable here, and only after the password was proven:
    // rehashing on a *failed* attempt would spend an Argon2 budget on every guess an attacker
    // makes, which is a denial of service they get for free.
    const rehashed =
      command.allowRehash &&
      this.config.allowRehash &&
      credential.needsRehash() &&
      (await this.upgrade(credential, command.password));

    // One save for the verification and any upgrade: two transactions would let a consumer see
    // `credential.verified` for a hash that was never written.
    await this.credentials.save(credential);

    return {
      valid: true,
      credentialId: credential.id.value,
      rehashed,
      failedAttempts: credential.failedAttempts,
    };
  }

  /** Re-hashes under current parameters and rotates the stored digest in place. */
  private async upgrade(credential: PasswordCredential, password: string): Promise<boolean> {
    const hash = await this.hasher.hash(password);
    credential.replaceSecret(hash, CredentialRotation.REHASHED);
    this.logger.log(`upgraded a weak Argon2 hash for ${credential.userId}`);
    return true;
  }
}

// ---- RevokeAllCredentials --------------------------------------------------------

@Injectable()
@CommandHandler(RevokeAllCredentialsCommand)
export class RevokeAllCredentialsHandler
  implements ICommandHandler<RevokeAllCredentialsCommand, { revokedCount: number }>
{
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepositoryPort,
  ) {}

  /**
   * Retires every live credential and burns every recovery code.
   *
   * @remarks The recovery codes go with the passwords because they are the same kind of
   * secret: a caller who says "this account is not mine any more" means the bypass codes too,
   * and leaving them alive would make this command look like it worked.
   *
   * @remarks Both halves commit in one transaction. Revoking the passwords and then failing
   * to delete the codes would leave an account whose primary secret is gone and whose bypass
   * still works — the worst of the two worlds, and the one a user would have no way to detect.
   */
  async execute(command: RevokeAllCredentialsCommand): Promise<{ revokedCount: number }> {
    const revokedCount = await this.credentials.revokeAllCredentials({
      userId: command.userId,
      reason: command.reason,
    });
    return { revokedCount };
  }
}

// ---- RegenerateRecoveryCodes ------------------------------------------------------

@Injectable()
@CommandHandler(RegenerateRecoveryCodesCommand)
export class RegenerateRecoveryCodesHandler
  implements ICommandHandler<RegenerateRecoveryCodesCommand, { userId: string; codes: string[] }>
{
  private readonly logger = new Logger(RegenerateRecoveryCodesHandler.name);

  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepositoryPort,
    @Inject(VAULT_CONFIG) private readonly config: CredentialVaultConfig,
  ) {}

  /**
   * Issues a fresh set of recovery codes and invalidates the previous one.
   *
   * @remarks The plaintexts exist in this result and nowhere else — they are hashed into
   * digests by the aggregate before anything is written, and `recovery_codes` has no column
   * that could hold them. A caller that loses the response has to regenerate, which is the
   * intended behaviour for a one-time display.
   */
  async execute(
    command: RegenerateRecoveryCodesCommand,
  ): Promise<{ userId: string; codes: string[] }> {
    const count = command.count ?? this.config.recoveryCodeCount;
    if (!isValidRecoveryCodeCount(count)) {
      throw new ValidationException('recovery code count is out of range', { count });
    }

    const existing = await this.credentials.findRecoveryCodeSet(command.userId);

    // `issue` hands back both the aggregate and the codes it minted, because the aggregate
    // deliberately holds digests only. The plaintexts exist in exactly one place, and this is
    // it; a caller that loses this response has to regenerate, which is the point.
    let set: RecoveryCodeSet;
    let codes: readonly RecoveryCode[];

    if (existing) {
      set = existing;
      codes = existing.regenerate({ count });
    } else {
      const issued = RecoveryCodeSet.issue({ userId: command.userId, count });
      set = issued.set;
      codes = issued.codes;
    }

    await this.credentials.saveRecoveryCodeSet(set);

    this.logger.log(`issued ${count} recovery codes for ${command.userId}`);

    return { userId: command.userId, codes: codes.map((code) => code.value) };
  }
}