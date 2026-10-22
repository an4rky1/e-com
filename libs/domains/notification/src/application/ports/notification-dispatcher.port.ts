/**
 * @fileoverview How the consumer reaches the write side.
 *
 * @remarks A port rather than a direct `CommandBus` so the event processor is testable without
 * a Nest container. The processor's entire job is a protocol — claim, route, dispatch, release
 * — and testing it through a real command bus would make every idempotency test pay for a
 * container it does not care about.
 *
 * @remarks It is a *narrow* protocol on purpose. Two commands, both described by what they
 * mean, so a third command added to the bus cannot silently become something the consumer can
 * trigger.
 */
import type {
  MarkNotificationReadCommand,
  SendNotificationCommand,
  MarkNotificationReadResult,
  SendNotificationResult,
} from '../commands/notification.commands';

export const NOTIFICATION_DISPATCHER = Symbol('NOTIFICATION_DISPATCHER');

export interface NotificationDispatcherPort {
  send(command: SendNotificationCommand): Promise<SendNotificationResult>;
  markRead(command: MarkNotificationReadCommand): Promise<MarkNotificationReadResult>;
}