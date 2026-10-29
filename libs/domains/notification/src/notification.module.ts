/**
 * @fileoverview Nest wiring for the notification service.
 *
 * @remarks A factory rather than a static `@Module`, for the same reason as its siblings: the
 * channel set and the store mode come from `NOTIFICATION_*`, and a module whose metadata is
 * evaluated at import time reads the environment before `ConfigModule` has loaded it. It also
 * puts the "which providers does this deployment actually have" decision in one place, where it
 * is visible, instead of spread across four `@Injectable()`s that each quietly assumed one.
 *
 * @remarks There is no controller. This service is driven *entirely* by Kafka: it exposes
 * nothing over HTTP or gRPC, and adding an inbound surface would give an external caller the
 * ability to make a user receive a notification — which is a capability, not a convenience,
 * and one that belongs nowhere near an unauthenticated endpoint.
 */
import { Logger, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import { PrismaClient } from './generated/prisma/client';
import {
  NOTIFICATION_CONFIG,
  NOTIFICATION_PRISMA,
  StoreMode,
  resolveNotificationConfig,
  type NotificationConfig,
} from './notification.config';
import {
  MarkNotificationReadHandler,
  SendNotificationHandler,
} from './application/commands/notification.handlers';
import {
  GetNotificationStatusHandler,
  ListNotificationsHandler,
} from './application/queries/notification.queries';
import { NotificationService } from './application/facade/notification.service';
import { NotificationEventProcessor } from './application/consumers/notification-event.processor';
import { CommandBusNotificationDispatcher } from './application/adapters/cqrs-notification.adapter';
import { NOTIFICATION_DISPATCHER } from './application/ports/notification-dispatcher.port';
import { NOTIFICATION_DISPATCH_QUEUE } from './application/ports/notification-dispatch-queue.port';
import { NOTIFICATION_CHANNELS } from './domain/ports/notification-channel.port';
import { NotificationChannel } from './domain/value-objects/notification-channel.vo';
import { NOTIFICATION_STORE } from './domain/ports/notification-store.port';
import { CONSUMER_CLAIM_STORE } from './domain/ports/consumer-claim.port';
import {
  DefaultNotificationChannelRegistry,
  NoopNotificationChannel,
  consoleChannelsFor,
} from './infrastructure/channels/notification-channels';
import { PrismaConsumerClaimStore } from './infrastructure/persistence/prisma-consumer-claim.store';
import { PrismaNotificationStore, NOTIFICATION_TOPICS, TOPIC_BY_EVENT } from './infrastructure/persistence/prisma-notification.store';
import { InMemoryNotificationStore } from './infrastructure/persistence/in-memory-notification.store';
import { NotificationKafkaConsumer } from './infrastructure/messaging/notification.kafka.consumer';
import { NotificationHealthIndicator } from './notification.health';
import { QueueModule, NOTIFICATION_WORKER_QUEUE, NOTIFICATION_DISPATCH_QUEUE as NOTIFICATION_DISPATCH_QUEUE_NAME } from '@auth/infra/queue';
import { NotificationWorker } from './infrastructure/queues/notification-worker.queue';
import { NotificationDispatchWorker } from './infrastructure/queues/notification-dispatch.worker';
import { BullNotificationDispatchQueue } from './infrastructure/queues/notification-dispatch.queue';
@Module({})
export class NotificationModule {}

/**
 * Assembles the notification service.
 *
 * @remarks The provider graph is one chain, readable top to bottom: config → adapters → ports
 * → handlers → facade. Every port is bound to a `Symbol` from the port's own file, so the
 * application layer never names a class from `infrastructure/` and swapping the store for a
 * real `notifications` table is a one-line change here.
 */export function createNotificationModule(): DynamicModule {
  const logger = new Logger('NotificationModule');

  const configProvider: Provider = {
    provide: NOTIFICATION_CONFIG,
    useFactory: (): NotificationConfig => resolveNotificationConfig(),
  };

  const channelsProvider: Provider = {
    provide: NOTIFICATION_CHANNELS,
    inject: [NOTIFICATION_CONFIG],
    useFactory: (config: NotificationConfig) => {
      // `inapp` is bound to the no-op adapter rather than a console one: there is no console
      // for a message that is delivered to whoever opens the app, and a log line claiming it
      // was delivered is a claim nothing can check.
      const adapters = [
        new NoopNotificationChannel(),
        ...consoleChannelsFor(
          [NotificationChannel.EMAIL, NotificationChannel.SMS, NotificationChannel.PUSH],
          config,
        ),
      ];

      const registry = new DefaultNotificationChannelRegistry(adapters);

      if (registry.available().length === 1) {
        logger.warn(
          'no delivery channel is configured; notifications will be recorded and delivered nowhere',
        );
      }

      return registry;
    },
  };

  const storeProvider: Provider = {
    provide: NOTIFICATION_STORE,
    inject: [NOTIFICATION_PRISMA, NOTIFICATION_CONFIG],
    useFactory: (
      prisma: PrismaService<PrismaClient>,
      config: NotificationConfig,
    ) => {
      if (config.storeMode === StoreMode.MEMORY) {
        // Loud, because this is the option that loses data on restart and is invisible to a
        // second replica. Stated at boot rather than discovered during an incident.
        logger.warn(
          'NOTIFICATION_STORE_MODE=memory: notification records are process-local and will be lost on restart',
        );
        return new InMemoryNotificationStore((type) => topicFor(type));
      }

      return new PrismaNotificationStore(prisma);
    },
  };

  return {
    module: NotificationModule,
    imports: [
      CqrsModule.forRoot(),
      QueueModule.register({
        queues: [NOTIFICATION_WORKER_QUEUE, NOTIFICATION_DISPATCH_QUEUE_NAME],
      }),
    ],
    controllers: [],
    providers: [
      {
        provide: NOTIFICATION_PRISMA,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => {
          const databaseUrl = config.get<string>('DATABASE_URL');
          if (!databaseUrl) {
            // Refusing to boot beats a wrong default: the client must never be able to point at
            // another service's database and write to its outbox.
            throw new Error('DATABASE_URL is required by the notification module');
          }
          return new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
        },
      },
      configProvider,
      channelsProvider,
      storeProvider,
      // `useClass`, not `useFactory`: the claim store's constructor already names its own
      // dependencies with `@Inject`, so restating them here would be a second list to keep in
      // step — and the kind that drifts silently, because neither list fails to compile.
      { provide: CONSUMER_CLAIM_STORE, useClass: PrismaConsumerClaimStore },
      { provide: NOTIFICATION_DISPATCHER, useClass: CommandBusNotificationDispatcher },
      {
        provide: NOTIFICATION_DISPATCH_QUEUE,
        useClass: BullNotificationDispatchQueue,
      },

      // The workers own their queues. The resend worker owns the resend/cancel path with its
      // per-user rate limiter; the dispatch worker owns the hot path — one job per consumed
      // Kafka event — with concurrency instead of a limiter.
      NotificationWorker,
      NotificationDispatchWorker,

      SendNotificationHandler,
      MarkNotificationReadHandler,
      ListNotificationsHandler,
      GetNotificationStatusHandler,

      NotificationEventProcessor,
      NotificationKafkaConsumer,
      NotificationService,
      {
        provide: NotificationHealthIndicator,
        inject: [NOTIFICATION_STORE, NOTIFICATION_CHANNELS, NOTIFICATION_CONFIG],
        useFactory: (
          store: InstanceType<typeof PrismaNotificationStore> | InMemoryNotificationStore,
          channels: DefaultNotificationChannelRegistry,
          config: NotificationConfig,
        ) => new NotificationHealthIndicator(store, channels, config.storeMode),
      },
    ],
    exports: [
      NotificationService,
      NotificationEventProcessor,
      NotificationKafkaConsumer,
      NotificationHealthIndicator,
      NOTIFICATION_STORE,
      NOTIFICATION_CHANNELS,
      CONSUMER_CLAIM_STORE,
    ],
  };
}

/**
 * Domain event -> the topic its announcement rides on.
 *
 * @remarks The same table the durable store writes from, imported rather than restated. Two
 * copies of an event-to-topic map is how the in-memory store starts announcing a read on the
 * dispatch topic, and it only shows up in a store-mode switch nobody exercises in production.
 */
function topicFor(eventType: string): string {
  return TOPIC_BY_EVENT[eventType] ?? NOTIFICATION_TOPICS.DISPATCHED;
}