import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  GrpcStatus,
  type GrpcChannel,
  type GrpcCallOptions,
  type GrpcStatusCode,
} from './grpc-channel.port';

export interface HttpLikeResponse {
  status: number;
  trailers?: unknown;
  metadata?: unknown;
}

export interface ClientCtor {
  service: string;
  requestSerialize: (value: unknown) => Buffer;
  requestDeserialize: (value: Buffer) => unknown;
  responseSerialize: (value: unknown) => Buffer;
  responseDeserialize: (value: Buffer) => unknown;
  originalName?: string;
  path?: string;
}

export interface ClientMethodDefinition {
  (
    request: object,
    metadata: unknown,
    options: { deadline: Date },
    callback: (error: unknown, response: unknown) => void,
  ): void;
}

/**
 * `ClientGrpcProxy` adapter implementing the {@link GrpcChannel} port.
 *
 * @remarks Application code never sees this class. Keeping it here means the Nest
 * transport can be replaced, and unit tests can supply a literal object instead of standing
 * up a server.
 */
@Injectable()
export class NestGrpcChannel implements GrpcChannel, OnModuleDestroy {
  private readonly logger = new Logger(NestGrpcChannel.name);
  private closed = false;

  constructor(private readonly client: unknown) {}

  unary<TRequest extends object, TResponse>(
    method: string,
    request: TRequest,
    options: GrpcCallOptions,
  ): Promise<TResponse> {
    const service = method.split('/')[2]?.split('.').slice(0, 2).join('.').replace('.', '');
    const methodName = method.split('/')[2]?.split('.')[2];

    if (!service || !methodName) {
      return Promise.reject(new Error(`Malformed gRPC method path: "${method}"`));
    }

    const container = this.client as {
      getService(name: string): Record<string, ClientMethodDefinition>;
    };
    const clientMethod = container.getService(service)?.[methodName];

    if (!clientMethod) {
      return Promise.reject(
        new Error(`Method ${method} is not present in the loaded proto definition`),
      );
    }

    return new Promise<TResponse>((resolve, reject) => {
      clientMethod.call(
        clientMethod,
        request,
        toMetadata(options.metadata),
        { deadline: new Date(options.deadline) },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response as TResponse);
        },
      );
    });
  }

  getState(): ReturnType<GrpcChannel['getState']> {
    return this.closed ? 'SHUTDOWN' : 'READY';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closeable = this.client as { close?: () => void };
    closeable.close?.();
    this.logger.log('gRPC channel closed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

/** Numeric gRPC codes, in the order the protocol defines them. */
const STATUS_BY_CODE: readonly GrpcStatusCode[] = [
  GrpcStatus.OK,
  GrpcStatus.CANCELLED,
  GrpcStatus.UNKNOWN,
  GrpcStatus.INVALID_ARGUMENT,
  GrpcStatus.DEADLINE_EXCEEDED,
  GrpcStatus.NOT_FOUND,
  GrpcStatus.ALREADY_EXISTS,
  GrpcStatus.PERMISSION_DENIED,
  GrpcStatus.RESOURCE_EXHAUSTED,
  GrpcStatus.FAILED_PRECONDITION,
  GrpcStatus.ABORTED,
  GrpcStatus.OUT_OF_RANGE,
  GrpcStatus.UNIMPLEMENTED,
  GrpcStatus.INTERNAL,
  GrpcStatus.UNAVAILABLE,
  GrpcStatus.DATA_LOSS,
  GrpcStatus.UNAUTHENTICATED,
];

/** Reads a gRPC status code off whatever shape the transport produced. */
export function statusCodeOf(error: unknown): GrpcStatusCode {
  const candidate = error as { code?: number | string } | null;
  if (typeof candidate?.code === 'string') {
    return candidate.code as GrpcStatusCode;
  }
  if (typeof candidate?.code === 'number') {
    return STATUS_BY_CODE[candidate.code] ?? GrpcStatus.UNKNOWN;
  }
  return GrpcStatus.UNKNOWN;
}

/** Server pushback arrives as a `grpc-retry-pushback-ms` trailer. */
export function pushbackOf(response: HttpLikeResponse | undefined): number | undefined {
  const trailers = response?.trailers as
    | Map<string, unknown> | Record<string, unknown> | undefined;
  if (!trailers) return undefined;

  const raw =
    trailers instanceof Map ? trailers.get('grpc-retry-pushback-ms') : trailers['grpc-retry-pushback-ms'];

  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toMetadata(metadata?: Record<string, string>): unknown {
  if (!metadata) return undefined;
  // Deferred import keeps gRPC out of the module graph of services that never call out.
  const { Metadata } = require('@grpc/grpc-js') as typeof import('@grpc/grpc-js');
  const instance = new Metadata();
  for (const [key, value] of Object.entries(metadata)) instance.set(key, value);
  return instance;
}