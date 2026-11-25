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
      // A signed-in account with no recognised role is still a user, not an unknown kind.
      actorKind: 'user',
      sessionId: SESSION_ID,
    });
  });

  it('reads the caller\'s user id from the principal, never from the request', async () => {
    const { service, identity } = serviceWith();

    await service.me(principalOf({ userId: 'someone-else' }));

    expect(identity.fetchedById).toEqual(['someone-else']);
  });

  it('resolves a guest caller by the id that travels as sessionId', async () => {
    const { service, identity, accessControl } = serviceWith();
    const GUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    identity.user = userOf({
      id: GUEST_ID,
      email: `guest-${GUEST_ID}@guest.invalid`,
      status: 'guest',
    });
    accessControl.roles = [];
    accessControl.permissions = [];

    const current = await service.me({ userId: '', email: '', sessionId: GUEST_ID });

    // Both peers are asked about the guest id: for a session-only principal it *is* the
    // subject — the row identity minted, the key access-control reads grants by.
    expect(identity.fetchedById).toEqual([GUEST_ID]);
    expect(accessControl.permissionLookups).toEqual([GUEST_ID]);
    expect(current).toEqual({
      user: identity.user,
      // `guest` is derived from the account status: it is not an assignment, so
      // access-control is still asked and still answers with no grants.
      roles: ['guest'],
      permissions: [],
      actorKind: 'guest',
      sessionId: GUEST_ID,
    });
  });

  it('reports the strongest role the caller holds as their actor kind', async () => {
    const { service, identity, accessControl } = serviceWith();
    identity.user = userOf({ status: 'active' });
    accessControl.roles = ['user', 'moderator'];
    accessControl.permissions = ['catalog:product.create'];

    const current = await service.me(principalOf());

    expect(current.actorKind).toBe('moderator');
  });

  it('asks identity about a guest id instead of composing an answer from nothing', async () => {
    // A well-formed uuid no row answers to — never minted, or reaped — gets identity's own
    // 404. A profile invented at the edge would be a caller with a status nobody ever gave.
    const { service, identity } = serviceWith();
    const GUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    identity.getError = new ResourceNotFoundException('user not found');

    const error = await service
      .me({ userId: '', email: '', sessionId: GUEST_ID })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceNotFoundException);
    expect(identity.fetchedById).toEqual([GUEST_ID]);
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
