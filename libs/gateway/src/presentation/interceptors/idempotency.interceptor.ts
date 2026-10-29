/**
 * @fileoverview Runs the claim → handle → record cycle for routes marked `@Idempotent()`.
 *
 * @remarks An interceptor rather than a guard, because idempotency is about the *result*:
 * the key is claimed before the handler runs and completed with the response it produced,
 * and a guard could only refuse the request — it can neither replay a response nor record
 * that one was produced. Registered once as `APP_INTERCEPTOR` and opted into per route, so
 * the mechanism has one home while the decision stays on the handler it affects, where the
 * response that would be cached sits one line below it.
 *
 * @remarks Every absence is a pass-through rather than a refusal: no opt-in, no key header,
 * a safe method, or Redis unable to answer all run the handler untouched. Failing closed
 * would let a cache outage become an edge outage, and the routes marked here are the ones
 * an outage must not close — a login that must be retryable is the whole point of marking
 * it. The cost of that choice is one unprotected request per outage window, which is the
 * same request the client was going to send anyway.
 *
 * @remarks Guards have already run when this executes, so `request.principal` — and with it
 * the subject the key is scoped to — exists for authenticated routes. Scoping is what keeps
 * two callers who pick the same key from sharing each other's records; without it,
 * idempotency would be a response-disclosure feature rather than a duplicate filter.
 */
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
// Value import on purpose — see the note in `auth.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { catchError, concatMap, from, map, mergeMap, type Observable, of, throwError } from 'rxjs';
import {
  IDEMPOTENCY_CONFIG,
  type IdempotencyConfig,
  type IdempotencyMode,
  type IdempotencyOptions,
} from '@auth/infra/idempotency';
// Value import on purpose — the same emitDecoratorMetadata reasoning as above: a
// constructor parameter's type needs its value binding, or Nest cannot inject it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { IdempotencyService } from '@auth/infra/idempotency';
import {
  IdempotencyAlreadyProcessedException,
  IdempotencyInFlightException,
} from '@auth/platform/error-handling';
import { IDEMPOTENT } from '../decorators/idempotent';
import { clientIpOf, type GatewayRequest } from '../gateway-request';

/**
 * Methods with no side effect to duplicate. Claiming a key for one would spend a Redis
 * round trip protecting nothing, so a `@Get()` that gained the decorator by mistake is
 * still a plain read.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** How this response was produced: `processed`, `replayed`, `in-flight`, `already-processed`, `failed`. */
const STATUS_HEADER = 'X-Idempotency-Status';

/**
 * The UTF-8 size of the body as the record would store it, or `undefined` when the body
 * cannot be serialised at all.
 */
function serializedSize(body: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8');
  } catch {
    return undefined;
  }
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
    @Inject(IDEMPOTENCY_CONFIG) private readonly config: IdempotencyConfig,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Promise<Observable<unknown>> {
    const options = this.reflector.getAllAndOverride<IdempotencyOptions | undefined>(
      IDEMPOTENT,
      [context.getHandler(), context.getClass()],
    );
    if (!options || !this.idempotency.enabled) return next.handle();

    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    if (SAFE_METHODS.has(request.method)) return next.handle();

    const clientKey = this.idempotency.clientKeyOf(request.headers);
    // A key the client did not choose cannot deduplicate the retries it actually sends,
    // so a request without one runs unprotected rather than under a key nobody will repeat.
    if (clientKey === undefined) return next.handle();

    const key = this.idempotency.scopedKey({
      method: request.method,
      path: request.path,
      principalId: request.principal?.userId,
      ip: clientIpOf(request),
      clientKey,
    });

    const mode: IdempotencyMode = options.mode ?? 'dedup';
    const outcome = await this.idempotency.begin(key);

    switch (outcome.kind) {
      case 'unavailable':
        return next.handle();

      case 'in_flight':
        response.setHeader('Retry-After', String(outcome.retryAfterSec));
        response.setHeader(STATUS_HEADER, 'in-flight');
        // The delay is in the body as well as the header, for the client that reads only
        // one of them — and a client that guesses the delay usually guesses "immediately",
        // which turns this answer into a second load generator.
        throw new IdempotencyInFlightException('this idempotency key is already in flight', {
          idempotencyKey: clientKey,
          retryAfterSec: outcome.retryAfterSec,
        });

      case 'already_processed':
        response.setHeader(STATUS_HEADER, 'already-processed');
        throw new IdempotencyAlreadyProcessedException(
          'this idempotency key has already completed for this route',
          { idempotencyKey: clientKey },
        );

      case 'replay':
        response.statusCode = outcome.response.status;
        response.setHeader(STATUS_HEADER, 'replayed');
        return of(outcome.response.body);

      case 'proceed': {
        const ownerId = outcome.ownerId;
        return next.handle().pipe(
          // The record lands before the body is emitted: a client that retries the moment
          // it sees success then meets the record instead of the still-held claim.
          concatMap((body) =>
            from(this.record(key, ownerId, mode, response, body)).pipe(
              map(() => {
                response.setHeader(STATUS_HEADER, 'processed');
                return body;
              }),
            ),
          ),
          catchError((error: unknown) =>
            from(this.idempotency.release(key, ownerId).catch(() => undefined)).pipe(
              mergeMap(() => {
                response.setHeader(STATUS_HEADER, 'failed');
                return throwError(() => error);
              }),
            ),
          ),
        );
      }
    }
  }

  /**
   * Writes the outcome under the claim: the response a retry replays, or the marker that
   * refuses one.
   *
   * @remarks Never rejects. The handler has already done its work by the time this runs,
   * and turning a completed request into a 500 because the record write failed would be a
   * worse answer than the duplicate the record exists to prevent — the claim stays held and
   * expires on its own, and a retry that meets it waits rather than re-running.
   */
  private async record(
    key: string,
    ownerId: string,
    mode: IdempotencyMode,
    response: Response,
    body: unknown,
  ): Promise<void> {
    try {
      if (mode === 'replay') {
        const size = serializedSize(body);
        if (size !== undefined && size <= this.config.maxResponseSizeKb * 1024) {
          await this.idempotency.complete(key, ownerId, mode, {
            status: response.statusCode,
            body,
          });
          return;
        }
        // A body too large to store, or one that cannot be serialised at all: keep the
        // marker rather than the body. Releasing would let a retry run the handler again,
        // and the response already happened — a retry that meets a refusal is wrong only
        // for the caller that wanted the body back, while a re-run is wrong for the data.
        this.logger.warn(
          `idempotency body for ${key} exceeds ${this.config.maxResponseSizeKb}KB or is not serialisable; recording a marker instead`,
        );
        await this.idempotency.complete(key, ownerId, 'dedup');
        return;
      }

      await this.idempotency.complete(key, ownerId, mode);
    } catch (error) {
      this.logger.warn(
        `idempotency record for ${key} was not written: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
