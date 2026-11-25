/**
 * @fileoverview The browser's placeholder account, renewed or minted.
 *
 * @remarks A command, not a query, because it writes: every call may create a row and every
 * call refreshes the one it renews. Keeping it here means creation has one path — the same
 * place registration's has — and no transport can mint a guest row on its own.
 */
// Value import: `CommandBus.execute` resolves the handler from `command.constructor`, so
// the command must be a class — a plain interface cannot dispatch.
import { Command } from '@nestjs/cqrs';

export class AcquireGuestUserCommand extends Command<string> {
  readonly commandId: string = crypto.randomUUID();

  /**
   * @param userId The guest account this browser held before; absent on a first visit.
   *   Never trusted as an identity: it is honoured only when the row behind it is *still*
   *   a guest, so a real account's id buys nothing but a freshly minted placeholder.
   */
  constructor(readonly userId?: string) {
    super();
  }
}
