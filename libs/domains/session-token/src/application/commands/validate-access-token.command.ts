// Value import: `@nestjs/cqrs` dispatches on `command.constructor`, so this is a class.
import { Command } from '@nestjs/cqrs';

export interface AccessTokenValidation {
  readonly valid: boolean;
  readonly userId: string;
  readonly email: string;
  readonly roles: string[];
  readonly permissions: string[];
  readonly sessionId: string;
  /** Set when the token itself was genuine but the session is no longer usable. */
  readonly revocationReason: string;
}

export class ValidateAccessTokenCommand extends Command<AccessTokenValidation> {
  readonly commandId: string = crypto.randomUUID();

  constructor(readonly accessToken: string) {
    super();
  }
}

/**
 * Bus key. Must be unique per process — two classes with this name shadow each other.
 *
 * @remarks A command rather than a query even though it mutates nothing: validating an access
 * token is a *decision* with rules (signature, lifetime, session state) rather than a
 * projection of stored rows, and it must not be routed through a cache.
 */
export const toValidateAccessTokenCommand = (
  accessToken: string,
): ValidateAccessTokenCommand => new ValidateAccessTokenCommand(accessToken);