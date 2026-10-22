/**
 * @fileoverview The guard api-gateway reuses.
 *
 * @remarks Every branch here is a security failure rather than a bad response. Failing open lets
 * an unauthenticated caller through; failing closed locks every legitimate integration out; and
 * answering a scope failure with the credential error turns a five-minute fix into an outage
 * nobody can diagnose from the outside.
 *
 * @remarks The verifier is a stub, and legitimately so — the guard never learns *how* a key is
 * checked, which is the property under test. The checking is covered in
 * `api-key-authentication.spec.ts`.
 */

import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InvalidCredentialsException,
  PermissionDeniedException,
} from '@auth/platform/error-handling';
import {
  ApiKeyAuthGuard,
  apiKeyPrincipalOf,
} from '../src/presentation/guards/api-key-auth.guard';
import {
  REQUIRED_SCOPES,
  RequireScopes,
} from '../src/presentation/decorators/require-scopes.decorator';
import {
  INVALID_API_KEY_MESSAGE,
  type ApiKeyVerifier,
  type AuthenticatedApiKey,
} from '../src/application/authentication/api-key-authentication.service';
import { ApiKeyScope } from '../src/domain/value-objects/api-key-scope.vo';

const PRINCIPAL: AuthenticatedApiKey = {
  apiKeyId: '4f2c1b3a-5d6e-4f70-8192-a3b4c5d6e7f8',
  userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  prefix: 'test_a1b2c3d4',
  family: 'test',
  scopes: [ApiKeyScope.READ],
  status: 'active',
};

/** A verifier that only answers for the key it was given. */
class StubVerifier implements ApiKeyVerifier {
  readonly asked: string[] = [];

  constructor(private readonly answer: AuthenticatedApiKey | null = PRINCIPAL) {}

  async authenticate(presentedKey: string): Promise<AuthenticatedApiKey> {
    this.asked.push(presentedKey);
    if (!this.answer) {
      throw new InvalidCredentialsException(INVALID_API_KEY_MESSAGE, {});
    }
    return this.answer;
  }
}

/** The minimal `ExecutionContext` shape the guard reads. */
const contextFor = (
  request: Record<string, unknown>,
  scopes?: readonly ApiKeyScope[],
): ExecutionContext => {
  const handler = (): void => undefined;
  if (scopes) Reflect.defineMetadata(REQUIRED_SCOPES, [...scopes], handler);

  return {
    getHandler: () => handler,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

const guardFor = (answer: AuthenticatedApiKey | null = PRINCIPAL) => {
  const verifier = new StubVerifier(answer);
  return { verifier, guard: new ApiKeyAuthGuard(new Reflector(), verifier) };
};

describe('RequireScopes', () => {
  it('sets metadata a reflector can read back', () => {
    class Target {
      @RequireScopes(ApiKeyScope.WRITE)
      handler(): void {
        /* noop */
      }
    }

    expect(new Reflector().get<ApiKeyScope[]>(REQUIRED_SCOPES, Target.prototype.handler)).toEqual([
      ApiKeyScope.WRITE,
    ]);
  });
});

describe('ApiKeyAuthGuard — admits', () => {
  it('admits a request carrying a valid key in X-API-Key', async () => {
    const { guard, verifier } = guardFor();
    const request = { headers: { 'x-api-key': 'test_a1b2c3d4_B'.repeat(43) } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(verifier.asked).toHaveLength(1);
  });

  it('attaches the resolved key and its scopes to the request', async () => {
    const { guard } = guardFor();
    const request: Record<string, unknown> = { headers: { 'x-api-key': 'test_a1b2c3d4_x' } };

    await guard.canActivate(contextFor(request));

    expect(apiKeyPrincipalOf(request)).toMatchObject({
      apiKeyId: PRINCIPAL.apiKeyId,
      userId: PRINCIPAL.userId,
      scopes: [ApiKeyScope.READ],
    });
    // Nothing secret: the principal is read by every handler downstream.
    expect(JSON.stringify(request.apiKey)).not.toMatch(/secret|hash/i);
  });

  it('reads a bearer token as well', async () => {
    const { guard, verifier } = guardFor();

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: `Bearer ${'k'.repeat(57)}` } }),
      ),
    ).resolves.toBe(true);
    expect(verifier.asked).toEqual(['k'.repeat(57)]);
  });

  it('accepts either spelling of the header', async () => {
    const { guard } = guardFor();

    // A guard that works against a real Node request but not against a plain object is a
    // credential that fails in one test and works in production.
    await expect(
      guard.canActivate(contextFor({ headers: { 'X-API-Key': 'upper-case' } })),
    ).resolves.toBe(true);
  });

  it('prefers the header over the bearer token', async () => {
    const { guard, verifier } = guardFor();

    await guard.canActivate(
      contextFor({ headers: { 'x-api-key': 'from-header', authorization: 'Bearer from-bearer' } }),
    );

    expect(verifier.asked).toEqual(['from-header']);
  });

  it('admits a route that asks for no scope at all', async () => {
    const { guard } = guardFor();

    await expect(
      guard.canActivate(contextFor({ headers: { 'x-api-key': 'any' } }, [])),
    ).resolves.toBe(true);
  });
});

describe('ApiKeyAuthGuard — refuses', () => {
  it('refuses a request with no credential at all', async () => {
    const { guard, verifier } = guardFor();

    // The other half of the indistinguishability rule: "you sent nothing" must answer exactly as
    // "you sent the wrong thing", or the guard tells an attacker which half to work on.
    const error = (await guard.canActivate(contextFor({ headers: {} })).catch((e: unknown) => e)) as InvalidCredentialsException;

    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(error.message).toBe(INVALID_API_KEY_MESSAGE);
    expect(verifier.asked).toHaveLength(0);
  });

  it('refuses an empty or whitespace-only header without asking the verifier', async () => {
    const { guard, verifier } = guardFor();

    await expect(
      guard.canActivate(contextFor({ headers: { 'x-api-key': '   ' } })),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
    expect(verifier.asked).toHaveLength(0);
  });

  it('refuses a request with no headers object at all', async () => {
    const { guard } = guardFor();

    await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });

  it('refuses a key the verifier will not stand behind', async () => {
    const { guard } = guardFor(null);

    await expect(
      guard.canActivate(contextFor({ headers: { 'x-api-key': 'test_x_wrong' } })),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
  });

  it('refuses a read-only key on a route that requires write', async () => {
    const { guard } = guardFor();

    const error = (await guard
      .canActivate(
        contextFor({ headers: { 'x-api-key': 'read-only' } }, [ApiKeyScope.WRITE]),
      )
      .catch((e: unknown) => e)) as PermissionDeniedException;

    expect(error).toBeInstanceOf(PermissionDeniedException);
    // Not the credential error: the caller proved who it is, and only the authority is wrong.
    // Collapsing the two makes an insufficient-scope integration impossible to debug.
    expect(error).not.toBeInstanceOf(InvalidCredentialsException);
    expect(error.context).toEqual({ required: [ApiKeyScope.WRITE] });
  });

  it('refuses a key that satisfies only part of the requirement', async () => {
    const { guard } = guardFor({ ...PRINCIPAL, scopes: [ApiKeyScope.READ, ApiKeyScope.WRITE] });

    await expect(
      guard.canActivate(
        contextFor({ headers: { 'x-api-key': 'k' } }, [ApiKeyScope.WRITE, ApiKeyScope.DELETE]),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
  });

  it('lets an admin key through any requirement, including one it does not carry', async () => {
    const { guard } = guardFor({ ...PRINCIPAL, scopes: [ApiKeyScope.ADMIN] });

    for (const required of [
      [ApiKeyScope.READ],
      [ApiKeyScope.WRITE],
      [ApiKeyScope.DELETE],
      [ApiKeyScope.READ, ApiKeyScope.WRITE, ApiKeyScope.DELETE],
    ]) {
      await expect(
        guard.canActivate(contextFor({ headers: { 'x-api-key': 'admin' } }, required)),
      ).resolves.toBe(true);
    }
  });

  it('attaches nothing to a request it refused', async () => {
    const { guard } = guardFor();
    const request = { headers: { 'x-api-key': 'read-only' } };

    await guard
      .canActivate(contextFor(request, [ApiKeyScope.DELETE]))
      .catch(() => undefined);

    // A downstream handler reading a principal off a refused request would be reading state the
    // guard never established.
    expect(apiKeyPrincipalOf(request)).toBeNull();
  });

  it('answers the same error for no credential and for a refused one', async () => {
    const { guard } = guardFor(null);

    const none = await guard.canActivate(contextFor({ headers: {} })).catch((e: unknown) => e);
    const wrong = await guard
      .canActivate(contextFor({ headers: { 'x-api-key': 'test_x_wrong' } }))
      .catch((e: unknown) => e);

    expect(none).toBeInstanceOf(InvalidCredentialsException);
    expect(wrong).toBeInstanceOf(InvalidCredentialsException);
    expect((none as Error).message).toBe((wrong as Error).message);
  });
});

describe('apiKeyPrincipalOf', () => {
  it('answers null rather than throwing for anything that is not a request', () => {
    expect(apiKeyPrincipalOf(null)).toBeNull();
    expect(apiKeyPrincipalOf(undefined)).toBeNull();
    expect(apiKeyPrincipalOf('nope')).toBeNull();
    expect(apiKeyPrincipalOf({})).toBeNull();
  });
});