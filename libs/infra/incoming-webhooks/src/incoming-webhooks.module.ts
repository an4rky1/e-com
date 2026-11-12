import { type DynamicModule, Global, Module } from '@nestjs/common';
import {
  resolveIncomingWebhooksConfig,
  WEBHOOKS_CONFIG,
} from './incoming-webhooks.config';
import { IncomingWebhooksService } from './incoming-webhooks.service';

/**
 * The verification and deduplication layer every PSP/webhook receiver sits behind.
 *
 * @remarks Global so route modules register handlers without an import edge from
 * presentation into the framework itself — the service that owns the route already knows
 * its own secret; this module only owns verify → dedupe → dispatch.
 */
@Global()
@Module({})
export class IncomingWebhooksModule {
  static register(): DynamicModule {
    return {
      module: IncomingWebhooksModule,
      providers: [
        { provide: WEBHOOKS_CONFIG, useValue: resolveIncomingWebhooksConfig() },
        IncomingWebhooksService,
      ],
      exports: [IncomingWebhooksService, WEBHOOKS_CONFIG],
    };
  }
}
