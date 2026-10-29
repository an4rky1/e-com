/**
 * @fileoverview Per-request correlation and request ids for the edge.
 *
 * @remarks Config-only — no Redis, no Prisma, no client of any kind. The context is an
 * `AsyncLocalStorage` cell and two response headers; giving it a dependency would mean a
 * request could not be traced because something else was down.
 */
import { type DynamicModule, Global, Module } from '@nestjs/common';
import {
  CONTEXT_CONFIG,
  resolveContextConfig,
  type ContextConfig,
} from './context.config';
import { RequestContextService } from './context.service';

@Global()
@Module({})
export class RequestContextModule {
  static register(
    options: { config?: Partial<ContextConfig> } = {},
  ): DynamicModule {
    const config = resolveContextConfig();

    return {
      module: RequestContextModule,
      providers: [
        { provide: CONTEXT_CONFIG, useValue: { ...config, ...options } },
        RequestContextService,
      ],
      exports: [CONTEXT_CONFIG, RequestContextService],
    };
  }
}
