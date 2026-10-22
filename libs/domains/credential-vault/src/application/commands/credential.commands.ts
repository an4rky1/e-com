/**
 * @fileoverview Commands that change a stored secret.
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
import { Command } from '@nestjs/cqrs';

/** Result of a `VerifyPasswordCommand`. Failure is an exception, never a `false`. */
export interface PasswordVerification {
  valid: true;
  credentialId: string;
  /** True when the stored hash was upgraded during this call. */
  rehashed: boolean;
  failedAttempts: number;
}

export class SetPasswordCommand extends Command<string> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly newPassword: string,
    /** Label written to `credentials.identifier`. Defaults to `password`. */
    readonly identifier?: string,
  ) {
    super();
  }
}

export class ChangePasswordCommand extends Command<string> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly currentPassword: string,
    readonly newPassword: string,
  ) {
    super();
  }
}

export class VerifyPasswordCommand extends Command<PasswordVerification> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly password: string,
    /**
     * Whether a hash made under weaker parameters may be upgraded here.
     *
     * @remarks An argument rather than configuration at the call site: the upgrade is free on
     * a successful sign-in and pointless anywhere else, so the only question is whether this
     * particular call is the moment the user proved themselves.
     */
    readonly allowRehash = true,
    readonly identifier?: string,
  ) {
    super();
  }
}

export class RevokeAllCredentialsCommand extends Command<{ revokedCount: number }> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly reason: string,
  ) {
    super();
  }
}

export class RegenerateRecoveryCodesCommand extends Command<{ userId: string; codes: string[] }> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly count?: number,
  ) {
    super();
  }
}

export const toSetPasswordCommand = (input: {
  userId: string;
  newPassword: string;
  identifier?: string;
}): SetPasswordCommand => new SetPasswordCommand(input.userId, input.newPassword, input.identifier);

export const toChangePasswordCommand = (input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): ChangePasswordCommand =>
  new ChangePasswordCommand(input.userId, input.currentPassword, input.newPassword);

export const toVerifyPasswordCommand = (input: {
  userId: string;
  password: string;
  allowRehash?: boolean;
  identifier?: string;
}): VerifyPasswordCommand =>
  new VerifyPasswordCommand(
    input.userId,
    input.password,
    input.allowRehash ?? true,
    input.identifier,
  );

export const toRevokeAllCredentialsCommand = (input: {
  userId: string;
  reason: string;
}): RevokeAllCredentialsCommand => new RevokeAllCredentialsCommand(input.userId, input.reason);

export const toRegenerateRecoveryCodesCommand = (input: {
  userId: string;
  count?: number;
}): RegenerateRecoveryCodesCommand =>
  new RegenerateRecoveryCodesCommand(input.userId, input.count);