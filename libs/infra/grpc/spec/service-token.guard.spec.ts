/**
 * @fileoverview What the service-token guard admits, and what it refuses.
 *
 * @remarks The cases below are the ones a real call can arrive in: no metadata at all, a
 * missing header, an empty one, a repeated one, a wrong one. Each is refused. The one case
 * that is *allowed* — a single, matching value — is asserted just as explicitly, because a
 * guard that refused everything would pass every negative test in this file.
 *
 * @remarks The fixture is built on the shape a call over the *wire* actually has, verified
 * against a live server: Nest hands a gRPC guard the request `Metadata` object as the RPC
 * context itself. The two other shapes a transport may expose — a server call carrying
 * `.metadata`, and the `getMetadata()` accessor the Nest docs quote — are asserted too,
 * because a guard that reads only one of the three passes its unit tests and then refuses, or
 * never even sees, every real call arriving in the others.
 */
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { GrpcControllerBase } from '../src/grpc-server';
import { GRPC_SERVICE_TOKEN_METADATA_KEY, readServiceToken } from '../src/service-token';
import { GrpcServiceTokenGuard } from '../src/service-token.guard';

const TOKEN = 'a-shared-service-token-value';

function headerMetadata(values: unknown) {
  return {
    get: (key: string) =>
      key === GRPC_SERVICE_TOKEN_METADATA_KEY ? values : undefined,
  };
}

/** The wire shape: Nest passes the request Metadata as the RPC context itself. */
function contextWithHeader(values: unknown): ExecutionContext {
  return {
    switchToRpc: () => ({
      getContext: () => headerMetadata(values),
    }),
  } as unknown as ExecutionContext;
}

/** A raw grpc-js server call, which carries request metadata as a property. */
function contextWithCallMetadata(values: unknown): ExecutionContext {
  return {
    switchToRpc: () => ({
      getContext: () => ({ metadata: headerMetadata(values) }),
    }),
  } as unknown as ExecutionContext;
}

/** The accessor shape the Nest docs quote for the RPC context. */
function contextWithMetadataAccessor(values: unknown): ExecutionContext {
  return {
    switchToRpc: () => ({
      getContext: () => ({ getMetadata: () => headerMetadata(values) }),
    }),
  } as unknown as ExecutionContext;
}

function contextWithoutMetadata(): ExecutionContext {
  return {
    switchToRpc: () => ({
      getContext: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('GrpcServiceTokenGuard', () => {
  const guard = new GrpcServiceTokenGuard(TOKEN);

  it('admits a call presenting the expected token', () => {
    expect(guard.canActivate(contextWithHeader([TOKEN]))).toBe(true);
  });

  it('admits the expected token when the transport exposes metadata through an accessor instead', () => {
    expect(guard.canActivate(contextWithMetadataAccessor([TOKEN]))).toBe(true);
  });

  it('admits the expected token when a server call carries metadata as a property', () => {
    expect(guard.canActivate(contextWithCallMetadata([TOKEN]))).toBe(true);
  });

  it('refuses a wrong token through the property shape too', () => {
    expect(() => guard.canActivate(contextWithCallMetadata(['not-ours']))).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a wrong token through the accessor shape too', () => {
    expect(() => guard.canActivate(contextWithMetadataAccessor(['not-ours']))).toThrow(
      UnauthorizedException,
    );
  });

  it('admits a Buffer-valued token, which is what grpc-js hands over for non-ASCII bytes', () => {
    expect(guard.canActivate(contextWithHeader([Buffer.from(TOKEN)]))).toBe(true);
  });

  it('refuses a wrong token', () => {
    expect(() => guard.canActivate(contextWithHeader(['not-ours']))).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a missing header', () => {
    expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses an empty header value, so "presented nothing" never counts as "presented the token"', () => {
    expect(() => guard.canActivate(contextWithHeader(['']))).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a repeated header, because two values cannot say which one was meant', () => {
    expect(() => guard.canActivate(contextWithHeader([TOKEN, TOKEN]))).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a call whose context exposes no metadata at all', () => {
    expect(() => guard.canActivate(contextWithoutMetadata())).toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a header whose value is neither a string nor a Buffer', () => {
    expect(() => guard.canActivate(contextWithHeader([{ unexpected: 'shape' }]))).toThrow(
      UnauthorizedException,
    );
  });

  it('reports the refusal without repeating the token it was checking', () => {
    try {
      guard.canActivate(contextWithHeader(['not-ours']));
      throw new Error('expected the call to be refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain('not-ours');
    }
  });

  it('refuses to be constructed with an empty token, which would admit calls presenting nothing', () => {
    expect(() => new GrpcServiceTokenGuard('')).toThrow(/non-empty service token/);
  });

  it('fails to boot when the environment carries no token, rather than starting open', () => {
    expect(() => readServiceToken({})).toThrow(/GRPC_SERVICE_TOKEN/);
  });
});

describe('the guard is attached where a new controller cannot forget it', () => {
  it('is registered on the base gRPC controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, GrpcControllerBase)).toEqual([
      GrpcServiceTokenGuard,
    ]);
  });

  it('reaches a subclass, which is the case that matters: a controller nobody remembered to guard', () => {
    abstract class IdentityGrpcController extends GrpcControllerBase {}

    // `Reflect.getMetadata` walks the prototype chain — Nest resolves guards the same way, so
    // this is the lookup that decides whether a subclass inherits the check.
    expect(Reflect.getMetadata(GUARDS_METADATA, IdentityGrpcController)).toEqual([
      GrpcServiceTokenGuard,
    ]);
  });
});
