import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { DEFAULT_DEADLINE_MS, GrpcRetryRegistry } from './grpc-channel.port';
import type { GrpcCallOptions, GrpcChannel } from './grpc-channel.port';
import { NestGrpcChannel, statusCodeOf } from './nest-grpc-channel';

export const GRPC_RETRY_REGISTRY = Symbol('GRPC_RETRY_REGISTRY');
export const GRPC_CHANNEL = Symbol('GRPC_CHANNEL');

/**
 * Applies the retry policy around a channel.
 *
 * @remarks Every call goes through the policy rather than the raw channel, including the
 * zero-retry default. The registry decides per method, so adding idempotency later does not
 * require touching any call site.
 */
@Injectable()
export class RetryingGrpcChannel implements GrpcChannel {
  constructor(
    private readonly inner: GrpcChannel,
    private readonly registry: GrpcRetryRegistry,
    private readonly defaultDeadlineMs = DEFAULT_DEADLINE_MS,
  ) {}

  async unary<TRequest extends object, TResponse>(
    method: string,
    request: TRequest,
    options?: Partial<GrpcCallOptions>,
  ): Promise<TResponse> {
    const started = Date.now();
    const deadline = options?.deadline ?? started + this.defaultDeadlineMs;

    let attempt = 0;

    for (;;) {
      try {
        return await this.inner.unary<TRequest, TResponse>(method, request, {
          deadline,
          metadata: options?.metadata,
        });
      } catch (error) {
        const spentMs = Date.now() - started;
        const decision = this.registry.decide(
          method,
          statusCodeOf(error),
          spentMs,
          attempt,
        );

        if (!decision.retry) {
          throw error;
        }

        await sleep(decision.delayMs);
        attempt += 1;
      }
    }
  }

  getState(): ReturnType<GrpcChannel['getState']> {
    return this.inner.getState();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export function createRetryingChannel(
  client: unknown,
  registry: GrpcRetryRegistry,
  deadlineMs?: number,
): RetryingGrpcChannel {
  return new RetryingGrpcChannel(
    new NestGrpcChannel(client),
    registry,
    deadlineMs,
  );
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });