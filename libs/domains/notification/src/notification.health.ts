/**
 * @fileoverview Readiness for the notification service.
 *
 * @remarks Two probes, because the service has two kinds of dependency and they fail for
 * unrelated reasons. The store is a *database*: if it is unreachable, nothing can be recorded
 * and every notification this service sends is invisible. The channels are *providers*: if
 * every one of them is unbound, the service is up, records everything, and delivers nothing —
 * which is a deployment mistake rather than an outage, so it reports `degraded`.
 */
import { HealthIndicator } from '@auth/platform/health';
import type { NotificationChannelRegistry } from './domain/ports/notification-channel.port';
import type { NotificationStorePort } from './domain/ports/notification-store.port';
import type { StoreMode } from './notification.config';

export class NotificationHealthIndicator extends HealthIndicator {
  constructor(
    private readonly store: NotificationStorePort,
    private readonly channels: NotificationChannelRegistry,
    private readonly storeMode: StoreMode,
  ) {
    super();
  }

  /**
   * @remarks `countUnread` rather than a socket ping: "can I record a notification" is the
   * question readiness actually cares about, and it exercises the same JSON-column read every
   * request will.
   */
  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();

    try {
      await this.store.countUnread('00000000-0000-4000-8000-000000000000');
    } catch (error) {
      return this.withStatus('notification', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const available = this.channels.available();

    return this.withStatus('notification', true, {
      latencyMs: Date.now() - started,
      storeMode: this.storeMode,
      channels: available,
      /**
       * `inapp` alone means nothing is leaving the process. It is still `up` rather than
       * `down`: pulling every replica out of rotation because no provider is bound turns a
       * deployment mistake into an outage, and the alternative — a service that is `up` and
       * sends nothing — is visible here instead.
       */
      delivering: available.length > 1,
    });
  }
}