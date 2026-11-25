/**
 * @fileoverview The single write path for the explicit guest-cart merge.
 *
 * @remarks Two refusals before any store is touched, both about what the call *is*: a
 * merge without a guest to fold is meaningless, and a merge with no signed-in user to
 * fold into would let an anonymous caller name an arbitrary target cart. The gateway only
 * ever calls this with a principal present; the checks exist because the RPC is a wire
 * surface, and a wire surface trusts nothing that arrives on it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import { CartWorkspace } from '../cart-workspace';
import { resolveCartOwner } from '../../domain/cart-owner';
import { MergeGuestCartCommand } from './cart.commands';

@Injectable()
@CommandHandler(MergeGuestCartCommand)
export class MergeGuestCartHandler
  implements ICommandHandler<MergeGuestCartCommand, boolean>
{
  constructor(@Inject(CartWorkspace) private readonly workspace: CartWorkspace) {}

  async execute(command: MergeGuestCartCommand): Promise<boolean> {
    const guestSessionId = command.guestSessionId?.trim() ?? '';
    if (guestSessionId.length === 0) {
      throw new ValidationException('a merge needs the guest session id it comes from', {
        guestSessionId: command.guestSessionId,
      });
    }

    if (command.identity.userId?.trim().length === 0) {
      // A session-only caller may hold a cart, but may not merge into anything: there is
      // no account on the other side of the fold, only another browser key.
      throw new ValidationException('a merge needs a signed-in user to merge into', {
        sessionId: command.identity.sessionId,
      });
    }

    // Refused before the store is touched, so an identity that cannot say which cart it
    // means never costs a round trip to find that out.
    resolveCartOwner(command.identity);

    return this.workspace.mergeFrom(command.identity, guestSessionId);
  }
}
