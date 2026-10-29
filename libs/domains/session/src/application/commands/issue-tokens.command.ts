/**
 * @fileoverview Issuing the first token pair for a login.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a REST
 * field never reaches the domain.
 */
// Value import: the command is a class because `@nestjs/cqrs` v11 resolves a handler
// from `command.constructor`. A plain interface or object literal can never dispatch, and
// a string bus key throws at import — `Reflect.hasOwnMetadata` rejects a non-object.
import { Command } from '@nestjs/cqrs';

export interface IssuedTokenPair {
  readonly sessionId: string;
  readonly tokenFamilyId: string;
  readonly accessToken: string;
  /** The only time this plaintext exists anywhere. */
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly expiresAt: string;
}

export class IssueTokensCommand extends Command<IssuedTokenPair> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly email: string,
    readonly roles?: readonly string[],
    readonly permissions?: readonly string[],
    readonly deviceId?: string,
    readonly ipAddress?: string,
    readonly userAgent?: string,
  ) {
    super();
  }
}

/** Convenience constructor, so the facade does not repeat the positional argument order. */
export const toIssueTokensCommand = (input: {
  userId: string;
  email: string;
  roles?: readonly string[];
  permissions?: readonly string[];
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
}): IssueTokensCommand => new IssueTokensCommand(
  input.userId,
  input.email,
  input.roles,
  input.permissions,
  input.deviceId,
  input.ipAddress,
  input.userAgent,
);