// Value import: `@nestjs/cqrs` dispatches on `command.constructor`, so this is a class.
import { Command } from '@nestjs/cqrs';
import type { IssuedTokenPair } from './issue-tokens.command';

export class RotateTokensCommand extends Command<IssuedTokenPair> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    /** The plaintext refresh token being exchanged. Never logged, never stored. */
    readonly refreshToken: string,
    readonly ipAddress?: string,
    readonly deviceId?: string,
  ) {
    super();
  }
}

export const toRotateTokensCommand = (input: {
  refreshToken: string;
  ipAddress?: string;
  deviceId?: string;
}): RotateTokensCommand =>
  new RotateTokensCommand(input.refreshToken, input.ipAddress, input.deviceId);