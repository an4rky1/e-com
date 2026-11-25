/**
 * @fileoverview Sweeping abandoned guest rows.
 *
 * @remarks A command, not a service-level `deleteMany`: mutation has one hook per aggregate
 * area, and the hook for "rows identity itself created as guests, past their freshness
 * window" belongs here rather than in a timer that happens to run in this process.
 */
// Value import: `CommandBus.execute` resolves the handler from `command.constructor`.
import { Command } from '@nestjs/cqrs';

export class ReapGuestUsersCommand extends Command<number> {
  readonly commandId: string = crypto.randomUUID();
}
