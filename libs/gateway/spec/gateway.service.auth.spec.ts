/**
 * @fileoverview The auth routes, as a use case rather than as HTTP.
 *
 * @remarks What is under test is delegation: that a login is `StartFlow` then `AdvanceFlow`,
 * that a refresh is one rotation, that a logout is a revocation scoped to the caller's user.
 * Each peer is an in-memory double, so a passing assertion is about this class's behaviour and
 * not about a peer being up.
 */
import { HttpStatus } from '@nestjs/common';
import {
  AccountLockedException,
  InvalidCredentialsException,
  MfaRequiredException,
  TokenReuseDetectedException,
  ValidationException,
} from '@auth/platform/error-handling';
import { GatewayService } from '../src/application/facade/gateway.service';
import { FlowState } from '../src/application/ports/peer-clients.port';
import {
  ACCESS_TOKEN,
  EMAIL,
  FakeAccessControlClient,
  FakeAuthFlowClient,
  FakeCredentialVaultClient,
  FakeIdentityClient,
  FakeSessionClient,
  PASSWORD,
  SESSION_ID,
  USER_ID,
  completedFlow,
  principalOf,
} from './testing/peer-doubles';

const serviceWith = () => {
  const flows = new FakeAuthFlowClient();
  const identity = new FakeIdentityClient();
  const accessControl = new FakeAccessControlClient();
  const sessions = new FakeSessionClient();
  const credentials = new FakeCredentialVaultClient();

  const service = new GatewayService(
    flows,
    identity,
    accessControl,
    sessions,
    credentials,
  );

  return { service, flows, identity, accessControl, sessions, credentials };
};

const loginOf = (service: GatewayService) =>
  service.login({ email: EMAIL, password: PASSWORD, ipAddress: '10.0.0.1' });

describe('GatewayService.login', () => {
  it('opens a flow and advances it with the password, in that order', async () => {
    const { service, flows } = serviceWith();

    await loginOf(service);

    expect(flows.started).toEqual([
      { email: EMAIL, ipAddress: '10.0.0.1', userAgent: undefined },
    ]);
    expect(flows.advanced).toEqual([{ flowId: 'flow-1', credential: PASSWORD }]);
  });

  it('returns the token pair the flow issued', async () => {
    const { service } = serviceWith();

    await expect(loginOf(service)).resolves.toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: 'refresh.token.value',
      expiresIn: 900,
      sessionId: SESSION_ID,
    });
  });

  it('refuses to send a password to a flow that is not awaiting one', async () => {
    const { service, flows } = serviceWith();
    flows.startResult = {
      ...flows.startResult,
      state: FlowState.AWAITING_2FA,
    };

    const error = await loginOf(service).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationException);
    expect((error as ValidationException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    // The credential never left this process.
    expect(flows.advanced).toEqual([]);
  });

  it.each([
    ['a wrong password', FlowState.FAILED],
    ['an expired flow', FlowState.EXPIRED],
    ['a cancelled flow', FlowState.CANCELLED],
    ['a state nobody has seen', 'awaiting_magic_link'],
  ])('reports %s as invalid credentials, not as an outage', async (_case, state) => {
    const { service, flows } = serviceWith();
    flows.advanceResult = completedFlow({
      state: state as FlowState,
      accessToken: '',
      refreshToken: '',
    });

    const error = await loginOf(service).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect((error as InvalidCredentialsException).getStatus()).toBe(
      HttpStatus.UNAUTHORIZED,
    );
  });

  it('reports a locked account as 423 with the wait, not as bad credentials', async () => {
    const { service, flows } = serviceWith();
    flows.advanceResult = completedFlow({
      state: FlowState.FAILED,
      accessToken: '',
      refreshToken: '',
      sessionId: '',
      expiresIn: undefined,
      locked: true,
      retryAfterSeconds: 900,
    });

    const error = (await loginOf(service).catch((e: unknown) => e)) as AccountLockedException;

    expect(error).toBeInstanceOf(AccountLockedException);
    expect(error.getStatus()).toBe(HttpStatus.LOCKED);
    // The seconds are the whole reason a lock is distinguishable: a caller told only "wrong
    // details" would keep retrying into a window that will not open.
    expect(error.context).toEqual({ retryAfterSeconds: 900 });
    expect(error.message).toBe('the account is temporarily locked');
  });

  it('passes a second-factor step through as MFA_REQUIRED, with the flow to continue', async () => {
    const { service, flows } = serviceWith();
    flows.advanceResult = {
      flowId: 'flow-9',
      state: FlowState.AWAITING_2FA,
      flow: 'login',
      message: 'enter your authenticator code',
    };

    const error = (await loginOf(service).catch((e: unknown) => e)) as MfaRequiredException;

    expect(error).toBeInstanceOf(MfaRequiredException);
    expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    // Not a failure: the password was right and the walk continues on the same flow.
    expect(error.context).toEqual({
      flowId: 'flow-9',
      state: FlowState.AWAITING_2FA,
    });
    expect(error.message).toBe('enter your authenticator code');
  });

  it('refuses a flow that claims to be complete without issuing tokens', async () => {
    const { service, flows } = serviceWith();
    flows.advanceResult = completedFlow({ accessToken: '' });

    const error = await loginOf(service).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidCredentialsException);
  });
});

describe('GatewayService.refresh', () => {
  it('rotates the pair and returns the new one', async () => {
    const { service, sessions } = serviceWith();

    const result = await service.refresh({ refreshToken: 'refresh.token.value' });

    expect(sessions.rotated).toEqual(['refresh.token.value']);
    expect(result).toEqual({
      accessToken: 'access.rotated',
      refreshToken: 'refresh.rotated',
      expiresIn: 900,
      sessionId: 'session-2',
    });
  });

  it('reports a replayed refresh token as its own 401', async () => {
    const { service, sessions } = serviceWith();
    sessions.rotateResult = { ...sessions.rotateResult, reuseDetected: true };

    const error = await service
      .refresh({ refreshToken: 'refresh.token.value' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TokenReuseDetectedException);
    expect((error as TokenReuseDetectedException).getStatus()).toBe(
      HttpStatus.UNAUTHORIZED,
    );
  });
});

describe('GatewayService.logout', () => {
  it('ends the session it was called with', async () => {
    const { service, sessions } = serviceWith();

    const result = await service.logout(principalOf(), { reason: 'logout' });

    expect(sessions.revokedOne).toEqual([
      { sessionId: SESSION_ID, reason: 'logout' },
    ]);
    // The token used to call logout must stop working, so the session it belonged to cannot
    // be left standing — "keep the caller's session alive" is the everywhere-else case.
    expect(sessions.revoked).toEqual([]);
    expect(result).toEqual({ sessionId: SESSION_ID, revokedCount: 1 });
  });

  it('keeps nothing alive when the caller asks to sign out everywhere', async () => {
    const { service, sessions } = serviceWith();

    await service.logout(principalOf(), { reason: 'logout', everywhere: true });

    expect(sessions.revoked[0]?.exceptSessionId).toBeUndefined();
  });
});

describe('GatewayService.createUser and setPassword', () => {
  it('creates the account through identity, with the source recorded', async () => {
    const { service, identity } = serviceWith();

    await service.createUser({ email: EMAIL, displayName: 'Person', source: 'web' });

    expect(identity.created).toEqual([
      { email: EMAIL, displayName: 'Person', source: 'web' },
    ]);
  });

  it('stores the initial password in the vault and returns the credential id', async () => {
    const { service, credentials } = serviceWith();

    const result = await service.setPassword({
      userId: USER_ID,
      newPassword: PASSWORD,
    });

    // The credential id is safe to return and the password is not: the vault's identifier
    // names the row, the plaintext would name the secret.
    expect(credentials.stored).toEqual([
      { userId: USER_ID, newPassword: PASSWORD },
    ]);
    expect(result).toEqual({ userId: USER_ID, credentialId: 'cred-1' });
  });
});
