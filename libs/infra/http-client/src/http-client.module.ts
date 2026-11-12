import { type DynamicModule, Global, Module } from '@nestjs/common';
import { HTTP_CLIENT_CONFIG, resolveHttpClientConfig } from './http-client.config';
import { HttpClientService } from './http-client.service';

/**
 * One outbound HTTP stack for the whole process: timeouts, retries, and a per-origin
 * breaker.
 *
 * @remarks `@Global()` so a webhook or payment adapter gets it without an import edge —
 * the point of owning outbound HTTP centrally is that no service re-invents retry policy.
 */
@Global()
@Module({})
export class HttpClientModule {
  static register(): DynamicModule {
    return {
      module: HttpClientModule,
      providers: [
        { provide: HTTP_CLIENT_CONFIG, useValue: resolveHttpClientConfig() },
        HttpClientService,
      ],
      exports: [HttpClientService, HTTP_CLIENT_CONFIG],
    };
  }
}
