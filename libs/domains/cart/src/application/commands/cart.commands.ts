/**
 * @fileoverview Commands for the four ways a cart can change, and the results they return.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a
 * proto field never reaches the domain.
 *
 * @remarks Classes, not interfaces. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is
 * given — a plain object literal cannot dispatch at all.
 *
 * @remarks Every command answers with the cart it produced rather than a status, because
 * every `cart.v1` mutation returns a `Cart` and rebuilding one at each call site is how two
 * transports start disagreeing about what "added" looks like.
 */
import { Command } from '@nestjs/cqrs';
import type { CartReadModel } from '../cart-read-model';
import type { CartIdentity } from '../../domain/cart-owner';

export class AddItemCommand extends Command<CartReadModel> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly identity: CartIdentity,
    readonly sku: string,
    readonly quantity: number,
  ) {
    super();
  }
}

export class UpdateItemQtyCommand extends Command<CartReadModel> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly identity: CartIdentity,
    readonly sku: string,
    readonly quantity: number,
  ) {
    super();
  }
}

export class RemoveItemCommand extends Command<CartReadModel> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly identity: CartIdentity,
    readonly sku: string,
  ) {
    super();
  }
}

export class ClearCartCommand extends Command<CartReadModel> {
  readonly commandId: string = crypto.randomUUID();

  constructor(readonly identity: CartIdentity) {
    super();
  }
}

/**
 * Folds a named guest cart into the addressed cart — the explicit merge a login triggers.
 *
 * @remarks Answers with whether anything was folded rather than with a cart: the caller
 * (the edge, right after sign-in) needs to know the guest basket arrived, and rebuilding
 * a read model it is about to discard anyway would be work with no reader.
 */
export class MergeGuestCartCommand extends Command<boolean> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly identity: CartIdentity,
    readonly guestSessionId: string,
  ) {
    super();
  }
}
