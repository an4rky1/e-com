/**
 * @fileoverview The CQRS-backed implementation of the dispatcher's port.
 *
 * @remarks One adapter between the consumer and the command bus, so the bus stays a wiring
 * detail. The processor's tests exercise the whole protocol — claim, route, dispatch, release —
 * without a container, and this is the only place the two halves meet.
 */
import { Injectable } from '@nestjs/common';
// Value import, not `import type`: constructor-injected, and Nest resolves the
// token from the emitted value binding via `emitDecoratorMetadata`.
import { CommandBus } from '@nestjs/cqrs';
import type { NotificationDispatcherPort } from '../ports/notification-dispatcher.port';
import type {
  MarkNotificationReadCommand,
  MarkNotificationReadResult,
  SendNotificationCommand,
  SendNotificationResult,
} from '../commands/notification.commands';

@Injectable()
export class CommandBusNotificationDispatcher implements NotificationDispatcherPort {
  constructor(private readonly commandBus: CommandBus) {}

  send(command: SendNotificationCommand): Promise<SendNotificationResult> {
    return this.commandBus.execute<SendNotificationResult>(command);
  }

  markRead(command: MarkNotificationReadCommand): Promise<MarkNotificationReadResult> {
    return this.commandBus.execute<MarkNotificationReadResult>(command);
  }
}