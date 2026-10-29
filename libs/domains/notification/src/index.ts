/** @fileoverview The notification module's public API.

 * @remarks Everything exported here is something another module may depend on. The rule this
 * file enforces is that the *internals* stay internal: the routing table, the template catalogue
 * and the aggregate are reachable only through the facade and the consumer, so a caller cannot
 * construct a notification by hand, hand it a store it invented, or dispatch on a template name
 * that no route would ever produce.
 *
 * @remarks The template catalogue is exported deliberately — a caller rendering its own screen
 * needs to know a template's severity and subject — but the Zod schemas behind it are not,
 * because the only supported way to get variables past them is through a command.
 */

// config and module
export {
  Defaults as NotificationDefaults,
  NOTIFICATION_CONFIG,
  NOTIFICATION_PRISMA,
  StoreMode,
  notificationSchema,
  resolveNotificationConfig,
  type NotificationConfig,
  type NotificationEnvConfig,
} from './notification.config';
export {
  NotificationModule,
  createNotificationModule,
} from './notification.module';
export { NotificationHealthIndicator } from './notification.health';

// commands
export {
  MarkNotificationReadCommand,
  SendNotificationCommand,
  toMarkNotificationReadCommand,
  toSendNotificationCommand,
  type ChannelDeliverySummary,
  type MarkNotificationReadResult,
  type SendNotificationResult,
} from './application/commands/notification.commands';
export {
  MarkNotificationReadHandler,
  SendNotificationHandler,
} from './application/commands/notification.handlers';

// queries
export {
  GetNotificationStatusHandler,
  GetNotificationStatusQuery,
  ListNotificationsHandler,
  ListNotificationsQuery,
  toNotificationReadModel,
  type NotificationListReadModel,
  type NotificationReadModel,
} from './application/queries/notification.queries';

// the consumer, which is this service's actual entry point
export {
  ConsumerOutcomeKind,
  NotificationEventProcessor,
  parseEnvelope,
  type ConsumerOutcome,
} from './application/consumers/notification-event.processor';
export {
  NOTIFICATION_DISPATCHER,
  type NotificationDispatcherPort,
} from './application/ports/notification-dispatcher.port';
export {
  NOTIFICATION_DISPATCH_QUEUE,
  type NotificationDispatchJob,
  type NotificationDispatchQueuePort,
} from './application/ports/notification-dispatch-queue.port';
export {
  CommandBusNotificationDispatcher,
} from './application/adapters/cqrs-notification.adapter';

// the facade
export { NotificationService } from './application/facade/notification.service';

// domain vocabulary
export {
  DeliveryStatus,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SEVERITIES,
  NotificationChannel,
  NotificationSeverity,
  isNotificationChannel,
} from './domain/value-objects/notification-channel.vo';
export {
  NOTIFICATION_TEMPLATES,
  NotificationTemplate,
  isNotificationTemplate,
  type NotificationVariables,
  type TemplateVariableInput,
} from './domain/value-objects/notification-template.vo';
export { NotificationId } from './domain/value-objects/notification-id.vo';
export {
  NO_RECIPIENT,
  Notification,
  NotificationDispatched,
  NotificationOutcome,
  NotificationRead,
  addressFor,
  type ChannelDelivery,
  type NotificationRecord,
  type NotificationRecipient,
  type NotificationRequest,
} from './domain/notification.aggregate';

// routing and templates
export {
  EVENT_ROUTES,
  SUBSCRIBED_TOPICS,
  recipientFrom,
  resolveRoute,
  routeFor,
  userIdFrom,
  type EventRoute,
  type NotificationInstruction,
  type RouteResolution,
} from './domain/event-routing';
export {
  TEMPLATES,
  compileTemplate,
  orderedChannels,
  resolveTemplate,
  type CompiledTemplate,
  type NotificationTemplateDefinition,
  type NotificationVariableSchema,
} from './domain/templates/notification-templates';
export {
  FORBIDDEN_PAYLOAD_KEY,
  announcementFor,
  assertPublishable,
  redactVariables,
  toVariableMap,
  type AnnouncementDelivery,
  type NotificationAnnouncement,
} from './domain/notification-announcement';

// ports
export {
  CONSUMER_CLAIM_STORE,
  ClaimRefusal,
  claimKeyFor,
  type ClaimKey,
  type ClaimResult,
  type ConsumerClaimStorePort,
} from './domain/ports/consumer-claim.port';
export {
  NOTIFICATION_CHANNELS as NOTIFICATION_CHANNEL_REGISTRY,
  type NotificationChannelPort,
  type NotificationChannelRegistry,
  type NotificationDeliveryReceipt,
  type NotificationMessage,
} from './domain/ports/notification-channel.port';
export {
  NOTIFICATION_STORE,
  type NotificationDeliverySummary,
  type NotificationListOptions,
  type NotificationStorePort,
} from './domain/ports/notification-store.port';

// infrastructure
export {
  ConsoleNotificationChannel,
  DefaultNotificationChannelRegistry,
  NoopNotificationChannel,
  consoleChannelsFor,
} from './infrastructure/channels/notification-channels';
export {
  CLAIM_EVENT_TYPE,
  PrismaConsumerClaimStore,
} from './infrastructure/persistence/prisma-consumer-claim.store';
export {
  NOTIFICATION_TOPICS,
  PrismaNotificationStore,
  RECORD_STATUS,
  TOPIC_BY_EVENT,
} from './infrastructure/persistence/prisma-notification.store';
export {
  InMemoryNotificationStore,
  type CapturedOutboxEvent,
} from './infrastructure/persistence/in-memory-notification.store';
export { NotificationKafkaConsumer } from './infrastructure/messaging/notification.kafka.consumer';
export {
  NotificationWorker,
  type NotificationJobPayload,
  type NotificationJobResult,
} from './infrastructure/queues/notification-worker.queue';
export {
  NotificationDispatchWorker,
  type NotificationDispatchProgress,
} from './infrastructure/queues/notification-dispatch.worker';
export { BullNotificationDispatchQueue } from './infrastructure/queues/notification-dispatch.queue';

// redaction layer, plus the helper that converts a notification into the shape downstream audit
// consumers should treat it as. That shape is a point, not an implementation detail, and it lives
// next to the notification's own contract rather than in the audit-log module — because it is the
// notification module's answer to "what does a notification event look like once it has been
// scrubbed for audit?"
export { type AuditAndNotificationRedactionShape, toAuditAndNotificationRedactionShape } from './domain/audit-and-notification-redaction.shape';
