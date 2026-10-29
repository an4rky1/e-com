/**
 * @fileoverview The wiring contract: middleware registered the way `GatewayModule` registers
 * it actually wraps every request under Nest 11's router.
 *
 * @remarks A `configure()` mistake (a wildcard Express 4 accepted, a method filter, a path
 * that never matches) fails silently in unit tests because every unit test calls the service
 * directly. This boots the real HTTP stack once and asks it two questions: does a traced
 * request come back with the id, and does a request that matches no route still get one —
 * the second is the whole reason the middleware mounts at `/` and not at a controller.
 */
import {
  Controller,
  Get,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
  Module,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RequestContextModule } from '../src/context.module';
import { RequestContextMiddleware } from '../src/context.middleware';
import { CorrelationId } from '../src/decorators/context.decorators';

@Controller('probe')
class ProbeController {
  @Get()
  probe(@CorrelationId() correlationId: string | undefined): {
    correlationId: string | undefined;
  } {
    return { correlationId };
  }
}

/** The registration shape `GatewayModule` uses: the same middleware, the same `/`. */
@Module({
  imports: [RequestContextModule.register()],
  controllers: [ProbeController],
})
class ProbeHostModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('/');
  }
}

describe('request context over real HTTP', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeHostModule, { logger: false });
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('echoes a caller-supplied correlation id and passes it to the handler', async () => {
    const response = await fetch(`${base}/probe`, {
      headers: { 'x-correlation-id': 'trace-9' },
    });
    const body = (await response.json()) as {
      correlationId?: string;
    };

    expect(response.headers.get('x-correlation-id')).toBe('trace-9');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.correlationId).toBe('trace-9');
  });

  it('mints an id for a request that matches no route at all', async () => {
    const response = await fetch(`${base}/no-such-path`);
    expect(response.status).toBe(404);
    expect(response.headers.get('x-correlation-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
