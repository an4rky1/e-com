/**
 * @fileoverview `/auth/me`: one response, composed from two services.
 *
 * @remarks The composition is the interesting part. A profile without its permissions reads
 * as "this user has none", which is a confident and completely wrong answer to hand a client —
 * so the response is all-or-nothing, and this file is what holds the edge to that.
 *
 * @remarks The access token is not re-validated here. It was validated by `JwtAuthGuard`,
 * which is what produced the principal this composes from; validating it a second time would
 * be a second opinion on a question session already answered, and two opinions drift.
 */
import { HttpStatus } from '@nestjs/common';
import {
  AppException,
  DependencyUnavailableException,
  ResourceNotFoundException,
} from '@auth/platform/error-handling';
import { GatewayService } from '../src/application/facade/gateway.service';
import {
  EMAIL,
  FakeAccessControlClient,
  FakeAuthFlowClient,
  FakeCredentialVaultClient,
  FakeIdentityClient,
  FakeSessionClient,
  SESSION_ID,
  USER_ID,
  principalOf,
  userOf,
} from './testing/peer-doubles';

const serviceWith = () => {
  const identity = new FakeIdentityClient();
  const accessControl = new FakeAccessControlClient();

  const service = new GatewayService(
    new FakeAuthFlowClient(),
    identity,
    accessControl,
    new FakeSessionClient(),
    new FakeCredentialVaultClient(),
  );

  return { service, identity, accessControl };
};

describe('GatewayService.me', () => {
  it('merges the identity lookup and the permission lookup into one answer', async () => {
    const { service, identity, accessControl } = serviceWith();
    identity.user = userOf({ displayName: 'Person', status: 'active' });
    accessControl.roles = ['member', 'support'];
    accessControl.permissions = ['users:read', 'users:write'];

    const current = await service.me(principalOf());

    expect(identity.fetchedById).toEqual([USER_ID]);
    expect(current).toEqual({
      user: identity.user,
      roles: ['member', 'support'],
      permissions: ['users:read', 'users:write'],
      sessionId: SESSION_ID,
    });
  });

  it('reads the caller\'s user id from the principal, never from the request', async () => {
    const { service, identity } = serviceWith();

    await service.me(principalOf({ userId: 'someone-else' }));

    expect(identity.fetchedById).toEqual(['someone-else']);
  });

  it('fails when the identity lookup fails', async () => {
    const { service, identity } = serviceWith();
    identity.getError = new ResourceNotFoundException('user not found');

    const error = await service.me(principalOf()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceNotFoundException);
    expect((error as ResourceNotFoundException).getStatus()).toBe(
      HttpStatus.NOT_FOUND,
    );
  });

  it('fails when the permission lookup fails', async () => {
    const { service, accessControl } = serviceWith();
    accessControl.getError = new DependencyUnavailableException();

    const error = await service.me(principalOf()).catch((e: unknown) => e);

    // Never a half-profile. "This user has no permissions" and "access-control is down" are
    // the same empty array, and only one of them is true.
    expect(error).toBeInstanceOf(DependencyUnavailableException);
    expect((error as DependencyUnavailableException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });

  it('does not report permissions minted into the token instead of asking', async () => {
    const { service, accessControl } = serviceWith();
    // The principal claims `users:admin`; access-control no longer grants it.
    accessControl.permissions = ['users:read'];

    const current = await service.me(
      principalOf({ permissions: ['users:admin'] }),
    );

    expect(current.permissions).toEqual(['users:read']);
  });

  it('reports the email identity has, not the one the token carries', async () => {
    const { service, identity } = serviceWith();
    identity.user = userOf({ email: 'current@example.com' });

    const current = await service.me(principalOf({ email: 'stale@example.com' }));

    // A claim is a snapshot taken at mint time. Reading it would answer "what was this user
    // an hour ago", which is not the question anybody asked.
    expect(current.user.email).toBe('current@example.com');
  });

  it('passes a peer failure through unchanged, so its status survives composition', async () => {
    const { service, identity } = serviceWith();
    identity.getError = new AppException({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'a required service could not be reached',
    });

    const error = (await service.me(principalOf()).catch((e: unknown) => e)) as AppException;

    // Re-wrapping here would replace the peer's diagnosis with the edge's, which is the one
    // thing the caller has least context to interpret.
    expect(error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('composes for a principal with no email, without inventing one', async () => {
    const { service, identity } = serviceWith();
    identity.user = userOf({ email: EMAIL });

    const current = await service.me(principalOf({ email: '' }));

    expect(current.user.email).toBe(EMAIL);
  });
});
