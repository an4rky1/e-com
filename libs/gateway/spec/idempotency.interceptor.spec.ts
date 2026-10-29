/**
 * @fileoverview `IdempotencyInterceptor`: which requests reach the service, and what the
 * answer is for each outcome.
 *
 * @remarks The service and its storage are tested against Redis elsewhere; this pins the
 * wiring — which requests pass through untouched, that a route's declared mode decides what
 * is stored, that a replay answers without running the handler, that a handler which
 * fails releases its claim so the client's retry is not refused by its own failure, and
 * which routes opt in at all.
 */
import 'reflect-metadata';
import type { CallHandler, ExecutionContext, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IdempotencyService,
  type IdempotencyConfig,
  type IdempotencyOptions,
  type IdempotencyStorage,
} from '@auth/infra/idempotency';
import {
  IdempotencyAlreadyProcessedException,
  IdempotencyInFlightException,
} from '@auth/platform/error-handling';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IDEMPOTENT, Idempotent } from '../src/presentation/decorators/idempotent';
import { IdempotencyInterceptor } from '../src/presentation/interceptors/idempotency.interceptor';
import type { GatewayRequest } from '../src/presentation/gateway-request';
import { AuthController } from '../src/presentation/auth.controller';
import { UsersController } from '../src/presentation/users.controller';

const config = (over: Partial<IdempotencyConfig> = {}): IdempotencyConfig => ({
  enabled: true,
  keyHeader: 'x-idempotency-key',
  prefix: 'idem',
  ttlSec: 300,
  markerTtlSec: 86_400,
  lockTimeoutMs: 30_000,
  maxKeyLength: 256,
  maxResponseSizeKb: 1_024,
  ...over,
});

/**
 * A real service — so `clientKeyOf` and `scopedKey` run their true logic — with the three
 * state-changing calls spied, and a storage that exists only to make `enabled` true.
 */
const harness = (over: Partial<IdempotencyConfig> = {}) => {
  const resolved = config(over);
  const service = new IdempotencyService(resolved, {
    available: true,
  } as unknown as IdempotencyStorage);
  const begin = jest
    .spyOn(service, 'begin')
    .mockResolvedValue({ kind: 'proceed', ownerId: 'owner-1' });
  const complete = jest.spyOn(service, 'complete').mockResolvedValue(undefined);
  const release = jest.spyOn(service, 'release').mockResolvedValue(undefined);
  const interceptor = new IdempotencyInterceptor(new Reflector(), service, resolved);
  return { interceptor, service, begin, complete, release };
};

class TestRoutes {
  plain(): string {
    return 'plain';
  }

  @Idempotent()
  dedup(): string {
    return 'dedup';
  }

  @Idempotent({ mode: 'replay' })
  replay(): string {
    return 'replay';
  }
}

const contextFor = (
  request: unknown,
  handler: keyof TestRoutes = 'dedup',
): { context: ExecutionContext; response: { setHeader: jest.Mock; statusCode: number } } => {
  const response = { setHeader: jest.fn(), statusCode: 201 };
  const context = {
    getHandler: () => TestRoutes.prototype[handler],
    getClass: () => TestRoutes,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
  return { context, response };
};

const requestFor = (over: Record<string, unknown> = {}): unknown =>
  ({
    method: 'POST',
    path: '/auth/login',
    headers: { 'x-idempotency-key': 'key-1' },
    socket: { remoteAddress: '203.0.113.7' },
    ...over,
  }) as unknown as GatewayRequest;

const nextFor = (body: unknown = { ok: true }): CallHandler<unknown> & { handle: jest.Mock } => ({
  handle: jest.fn(() => of(body)),
});

const failingNext = (error: unknown): CallHandler<unknown> & { handle: jest.Mock } => ({
  handle: jest.fn(() => throwError(() => error)),
});

const run = async (
  interceptor: IdempotencyInterceptor,
  context: ExecutionContext,
  next: CallHandler<unknown>,
): Promise<unknown> => lastValueFrom(await interceptor.intercept(context, next));

const STATUS = 'X-Idempotency-Status';

describe('IdempotencyInterceptor', () => {
  describe('pass-through', () => {
    it('leaves a route that never asked for idempotency completely alone', async () => {
      const { interceptor, begin } = harness();
      const { context } = contextFor(requestFor(), 'plain');
      const next = nextFor('plain-result');

      await expect(run(interceptor, context, next)).resolves.toBe('plain-result');
      expect(begin).not.toHaveBeenCalled();
      expect(next.handle).toHaveBeenCalledTimes(1);
    });

    it('runs a keyless request untouched — no key can deduplicate the retries it sends', async () => {
      const { interceptor, begin } = harness();
      const { context } = contextFor(requestFor({ headers: {} }));
      const next = nextFor();

      await expect(run(interceptor, context, next)).resolves.toEqual({ ok: true });
      expect(begin).not.toHaveBeenCalled();
    });

    it('runs a safe method untouched even when it carries a key', async () => {
      const { interceptor, begin } = harness();
      const { context } = contextFor(requestFor({ method: 'GET' }));
      const next = nextFor();

      await expect(run(interceptor, context, next)).resolves.toEqual({ ok: true });
      expect(begin).not.toHaveBeenCalled();
    });

    it('does nothing at all when idempotency is disabled', async () => {
      const { interceptor, begin } = harness({ enabled: false });
      const { context } = contextFor(requestFor());
      const next = nextFor();

      await expect(run(interceptor, context, next)).resolves.toEqual({ ok: true });
      expect(begin).not.toHaveBeenCalled();
    });

    it('runs the handler when Redis cannot answer', async () => {
      const { interceptor, begin, complete } = harness();
      begin.mockResolvedValue({ kind: 'unavailable' });
      const { context, response } = contextFor(requestFor());
      const next = nextFor('ran-anyway');

      await expect(run(interceptor, context, next)).resolves.toBe('ran-anyway');
      expect(complete).not.toHaveBeenCalled();
      expect(response.setHeader).not.toHaveBeenCalled();
    });
  });

  describe('dedup routes', () => {
    it('claims, runs once, and records a marker without the body', async () => {
      const { interceptor, service, begin, complete } = harness();
      const { context, response } = contextFor(requestFor());
      const next = nextFor({ accessToken: 'secret' });

      await expect(run(interceptor, context, next)).resolves.toEqual({
        accessToken: 'secret',
      });

      expect(begin).toHaveBeenCalledTimes(1);
      expect(begin.mock.calls[0][0]).toBe(
        service.scopedKey({
          method: 'POST',
          path: '/auth/login',
          principalId: undefined,
          ip: '203.0.113.7',
          clientKey: 'key-1',
        }),
      );
      // Exactly three arguments: a marker, never the response — the body holds tokens.
      expect(complete).toHaveBeenCalledWith(expect.any(String), 'owner-1', 'dedup');
      expect(response.setHeader).toHaveBeenCalledWith(STATUS, 'processed');
    });

    it('scopes an authenticated request to the principal rather than the address', async () => {
      const { interceptor, service, begin } = harness();
      const { context } = contextFor(
        requestFor({ path: '/users', principal: { userId: 'user-7' } }),
        'dedup',
      );

      await run(interceptor, context, nextFor());

      expect(begin.mock.calls[0][0]).toBe(
        service.scopedKey({
          method: 'POST',
          path: '/users',
          principalId: 'user-7',
          ip: '203.0.113.7',
          clientKey: 'key-1',
        }),
      );
    });
  });

  describe('replay routes', () => {
    it('stores the response body and the status it was produced with', async () => {
      const { interceptor, complete } = harness();
      const { context, response } = contextFor(requestFor({ path: '/users' }), 'replay');
      const next = nextFor({ id: 'user-1' });

      await expect(run(interceptor, context, next)).resolves.toEqual({ id: 'user-1' });

      expect(complete).toHaveBeenCalledWith(expect.any(String), 'owner-1', 'replay', {
        status: 201,
        body: { id: 'user-1' },
      });
      expect(response.setHeader).toHaveBeenCalledWith(STATUS, 'processed');
    });

    it('records a marker instead of a body too large to store, without re-running anything', async () => {
      const { interceptor, complete } = harness({ maxResponseSizeKb: 1 });
      const { context, response } = contextFor(requestFor(), 'replay');
      const next = nextFor({ blob: 'x'.repeat(2_048) });

      await expect(run(interceptor, context, next)).resolves.toBeTruthy();

      expect(complete).toHaveBeenCalledWith(expect.any(String), 'owner-1', 'dedup');
      expect(response.setHeader).toHaveBeenCalledWith(STATUS, 'processed');
    });

    it('answers a retry from the record without running the handler', async () => {
      const { interceptor, begin } = harness();
      begin.mockResolvedValue({
        kind: 'replay',
        response: { status: 200, body: { id: 'user-1' } },
      });
      const { context, response } = contextFor(requestFor({ path: '/users' }), 'replay');
      const next = nextFor();

      await expect(run(interceptor, context, next)).resolves.toEqual({ id: 'user-1' });

      expect(next.handle).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(200);
      expect(response.setHeader).toHaveBeenCalledWith(STATUS, 'replayed');
    });

    it('still serves the response when the record write fails', async () => {
      const { interceptor, complete } = harness();
      complete.mockRejectedValue(new Error('redis went away'));
      const { context, response } = contextFor(requestFor(), 'replay');
      const next = nextFor({ ok: true });

      await expect(run(interceptor, context, next)).resolves.toEqual({ ok: true });
      expect(response.setHeader).toHaveBeenCalledWith(STATUS, 'processed');
    });
  });

  describe('refusals', () => {
    it('refuses a duplicate while the first attempt is still running', async () => {
      const { interceptor, begin } = harness();
      begin.mockResolvedValue({ kind: 'in_flight', retryAfterSec: 5 });
      const { context, response } = contextFor(requestFor());
      const next = nextFor();

      await expect(interceptor.intercept(context, next)).rejects.toBeInstanceOf(
        IdempotencyInFlightException,
      );

      expect(next.handle).not.toHaveBeenCalled();
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '5');
      expect(response.setHeader).toHaveBeenCalledWith(STATUS, 'in-flight');
    });

    it('refuses a key whose request already completed', async () => {
      const { interceptor, begin } = harness();
      begin.mockResolvedValue({ kind: 'already_processed' });
      const { context, response } = contextFor(requestFor());
      const next = nextFor();

      const error = await interceptor.intercept(context, next).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IdempotencyAlreadyProcessedException);
      expect((error as IdempotencyAlreadyProcessedException).getStatus()).toBe(409);
      expect(next.handle).not.toHaveBeenCalled();
      expect(response.setHeader).toHaveBeenCalledWith(STATUS, 'already-processed');
    });
  });

  describe('handler failure', () => {
    it('releases the claim so the retry re-runs instead of meeting its own failure', async () => {
      const { interceptor, begin, complete, release } = harness();
      const boom = new Error('peer refused');
      const { context, response } = contextFor(requestFor());
      const next = failingNext(boom);

      await expect(run(interceptor, context, next)).rejects.toBe(boom);

      expect(begin).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(expect.any(String), 'owner-1');
      expect(complete).not.toHaveBeenCalled();
      expect(response.setHeader).toHaveBeenCalledWith(STATUS, 'failed');
    });
  });
});

describe('route opt-in', () => {
  const reflector = new Reflector();
  const modeOf = (
    handler: (...args: never[]) => unknown,
    controller: Type,
  ): IdempotencyOptions | undefined =>
    reflector.getAllAndOverride<IdempotencyOptions | undefined>(IDEMPOTENT, [
      handler,
      controller,
    ]);

  it('marks the mutating auth routes dedup — a replayed body must not mint a second token', () => {
    expect(modeOf(AuthController.prototype.login, AuthController)).toEqual({});
    expect(modeOf(AuthController.prototype.register, AuthController)).toEqual({});
    expect(modeOf(AuthController.prototype.refresh, AuthController)).toEqual({});
  });

  it('marks the two user-creating routes replay — their response is data worth replaying', () => {
    expect(modeOf(UsersController.prototype.create, UsersController)).toEqual({
      mode: 'replay',
    });
    expect(modeOf(UsersController.prototype.setPassword, UsersController)).toEqual({
      mode: 'replay',
    });
  });

  it('leaves every other handler — logout included — outside the interceptor', () => {
    expect(modeOf(AuthController.prototype.logout, AuthController)).toBeUndefined();
    expect(modeOf(AuthController.prototype.me, AuthController)).toBeUndefined();
    expect(modeOf(AuthController.prototype.oauthCallback, AuthController)).toBeUndefined();
  });
});
