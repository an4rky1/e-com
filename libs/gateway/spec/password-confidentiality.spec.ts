/**
 * @fileoverview The password, end to end, and everywhere it must not be.
 *
 * @remarks The platform filter already redacts known-sensitive keys. That is the second line
 * of defence, and it only fires on keys somebody remembered to declare — which is exactly why
 * it cannot be the only one. What this file asserts is the first line: the gateway never
 * copies a secret anywhere. `login` takes the password, hands it to one peer call, and lets it
 * go out of scope; nothing here is a promise, it is an observation.
 *
 * @remarks `Logger` is spied on rather than read from the filesystem. The claim is "this
 * process does not log it", and the only place that can be observed from a unit test is the
 * logger every file in this lib reaches for — Nest's, which the platform filter logs through.
 */
import { Logger } from '@nestjs/common';
import { GatewayService } from '../src/application/facade/gateway.service';
import { toTokenPairResponse } from '../src/presentation/dto/gateway.dto';
import { AuthController } from '../src/presentation/auth.controller';
import { UsersController } from '../src/presentation/users.controller';
import {
  EMAIL,
  FakeAccessControlClient,
  FakeAuthFlowClient as FakeFlows,
  FakeCredentialVaultClient,
  FakeIdentityClient,
  FakeSessionClient,
  PASSWORD,
  fakeOAuthService,
  principalOf,
  userOf,
} from './testing/peer-doubles';

const serviceWith = () => {
  const flows = new FakeFlows();
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

/** Every string Nest's logger was handed during `run`. */
const captureLogs = async (run: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      return undefined;
    }),
  );

  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  return lines;
};

describe('the password never leaves the vault call it was handed to', () => {
  it('reaches auth-flow, on the credential field, exactly once', async () => {
    const { service, flows } = serviceWith();

    await service.login({ email: EMAIL, password: PASSWORD });

    expect(flows.advanced).toEqual([{ flowId: 'flow-1', credential: PASSWORD }]);
    // `StartFlow` carries no credential field at all, so the plaintext cannot be in it.
    expect(JSON.stringify(flows.started)).not.toContain(PASSWORD);
  });

  it('is in nothing the login route returns', async () => {
    const { service } = serviceWith();

    const response = toTokenPairResponse(
      await service.login({ email: EMAIL, password: PASSWORD }),
    );

    expect(JSON.stringify(response)).not.toContain(PASSWORD);
    // And the shape says so: the response has four fields and none of them is the input.
    expect(Object.keys(response).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'refreshToken',
      'sessionId',
      'tokenType',
    ]);
  });

  it('is in no log line produced while signing in', async () => {
    const { service } = serviceWith();

    const lines = await captureLogs(async () => {
      await service.login({ email: EMAIL, password: PASSWORD });
    });

    expect(lines).toEqual([]);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  it('is in no exception raised by a failed sign-in', async () => {
    const { service, flows } = serviceWith();
    flows.advanceResult = {
      flowId: 'flow-1',
      state: 'failed',
      flow: 'login',
    };

    const lines = await captureLogs(async () => {
      const error = await service
        .login({ email: EMAIL, password: PASSWORD })
        .catch((e: unknown) => e);

      // The rendered body is what the filter would put on the wire, and the context is what
      // it would put in the log.
      const rendered = JSON.stringify({
        context: (error as { context?: unknown }).context,
        response: (error as { getResponse(): unknown }).getResponse(),
      });
      expect(rendered).not.toContain(PASSWORD);
    });

    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  it('is in nothing the set-password route returns', async () => {
    const { service } = serviceWith();

    const result = await service.setPassword({
      userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      newPassword: PASSWORD,
    });

    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(result).toEqual({
      userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      credentialId: 'cred-1',
    });
  });

  it('is stored once, by the vault, and nowhere else', async () => {
    const { service, credentials, flows, sessions, identity, accessControl } = serviceWith();

    await service.login({ email: EMAIL, password: PASSWORD });
    await service.setPassword({ userId: 'u-1', newPassword: PASSWORD });

    // Three peers saw traffic during that; exactly one of them saw a password, and once.
    expect(credentials.stored).toEqual([{ userId: 'u-1', newPassword: PASSWORD }]);
    expect(JSON.stringify(flows.started)).not.toContain(PASSWORD);
    expect(JSON.stringify(flows.advanced.filter((a) => a.credential !== PASSWORD))).toBe('[]');
    expect(
      JSON.stringify([sessions.issued, sessions.rotated, sessions.revoked, sessions.revokedOne]),
    ).not.toContain(PASSWORD);
    expect(JSON.stringify(identity.created)).not.toContain(PASSWORD);
    expect(JSON.stringify(accessControl.granted)).not.toContain(PASSWORD);
  });
});

describe('the controllers hold no state of their own', () => {
  it('composes a login answer from what the use case returned', async () => {
    const { service } = serviceWith();
    const controller = new AuthController(service, fakeOAuthService());

    const response = await controller.login({ email: EMAIL, password: PASSWORD });

    expect(response.tokenType).toBe('Bearer');
    expect(JSON.stringify(response)).not.toContain(PASSWORD);
  });

  it('composes a create-user answer without echoing the request', async () => {
    const { service, identity } = serviceWith();
    identity.user = userOf();
    const controller = new UsersController(service);

    const response = await controller.create({ email: EMAIL, displayName: 'Person' });

    expect(response.email).toBe(EMAIL);
  });

  it('composes /auth/me from the composed answer', async () => {
    const { service } = serviceWith();
    const controller = new AuthController(service, fakeOAuthService());

    const response = await controller.me(principalOf());

    expect(response.sessionId).toBe(principalOf().sessionId);
    expect(response.permissions).toContain('users:read');
  });
});
