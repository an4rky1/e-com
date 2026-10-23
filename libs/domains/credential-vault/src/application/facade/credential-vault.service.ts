/**
 * @fileoverview The only public surface of the credential-vault module.
 *
 * @remarks Controllers, gRPC handlers and other services depend on this class and nothing
 * else. They therefore cannot reach the repository, the CQRS bus or the aggregate — which is
 * what makes the module's internals replaceable without touching a single caller.
 *
 * @remarks Every method takes and returns plain data. The command classes are an implementation
 * detail of the bus: a caller that could construct them directly would be able to bypass the
 * policy this facade is meant to front.
 */
import { Injectable } from '@nestjs/common';
// Value import, not `import type`: these are constructor-injected, and
// `emitDecoratorMetadata` reads the emitted value binding to resolve them.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ChangePasswordCommand,
  RegenerateRecoveryCodesCommand,
  RevokeAllCredentialsCommand,
  SetPasswordCommand,
  VerifyPasswordCommand,
  type PasswordVerification,
} from '../commands/credential.commands';
import {
  GetCredentialStatusQuery,
  type CredentialStatusReadModel,
} from '../queries/credential.queries';

@Injectable()
export class CredentialVaultService {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Installs or replaces a password.
   *
   * @remarks Does not require the previous one — see {@link SetPasswordHandler}. Callers that
   * must prove possession use {@link changePassword}.
   *
   * @returns the credential id, which exists so a caller can correlate the write with the
   * `credential.rotated` event it will see on the outbox topic.
   */
  setPassword(input: {
    userId: string;
    newPassword: string;
    identifier?: string;
  }): Promise<string> {
    return this.commandBus.execute<string>(
      new SetPasswordCommand(input.userId, input.newPassword, input.identifier),
    );
  }

  /**
   * Rotates a password for someone who can present the old one.
   *
   * @remarks Rejects with the same {@link InvalidCredentialsException} as a failed sign-in, so
   * the "wrong current password" path is not a second account-enumeration oracle.
   */
  changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<string> {
    return this.commandBus.execute<string>(
      new ChangePasswordCommand(input.userId, input.currentPassword, input.newPassword),
    );
  }

  /**
   * Answers "prove you are this user".
   *
   * @remarks Resolves only on success. A wrong password, an unknown user, a revoked credential
   * and a locked one all raise the same exception with the same message; the distinction is
   * written to the log and published as a `credential.failed` event, never returned.
   */
  verifyPassword(input: {
    userId: string;
    password: string;
    allowRehash?: boolean;
    identifier?: string;
  }): Promise<PasswordVerification> {
    return this.commandBus.execute<PasswordVerification>(
      new VerifyPasswordCommand(
        input.userId,
        input.password,
        input.allowRehash ?? true,
        input.identifier,
      ),
    );
  }

  /**
   * Signs a user out of every credential they hold.
   *
   * @remarks Also burns their recovery codes — they are bypasses to the same account, and
   * leaving them alive would make this call look like it worked when it did not.
   */
  revokeAllCredentials(input: { userId: string; reason: string }): Promise<{
    revokedCount: number;
  }> {
    return this.commandBus.execute<{ revokedCount: number }>(
      new RevokeAllCredentialsCommand(input.userId, input.reason),
    );
  }

  /**
   * Issues a new set of recovery codes, invalidating the previous set.
   *
   * @remarks The returned codes are plaintext and are never stored — a caller that loses this
   * response has to regenerate. That is deliberate: it is what makes "only shown once" true
   * rather than a UI convention.
   */
  regenerateRecoveryCodes(input: { userId: string; count?: number }): Promise<{
    userId: string;
    codes: string[];
  }> {
    return this.commandBus.execute<{ userId: string; codes: string[] }>(
      new RegenerateRecoveryCodesCommand(input.userId, input.count),
    );
  }

  /** Credential state for a settings screen. Says nothing about whether the user exists. */
  getCredentialStatus(userId: string): Promise<CredentialStatusReadModel> {
    return this.queryBus.execute(new GetCredentialStatusQuery(userId));
  }
}