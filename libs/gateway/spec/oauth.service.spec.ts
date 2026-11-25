/**
 * @fileoverview The provider walk, room by room.
 *
 * @remarks Three claims get exercised here. First, the *order*: state before code, provider
 * before identity, identity before tokens — a forged callback must cost the exchange
 * nothing, and a refusal anywhere must leave no session behind. Second, the *verification
 * requirement*: only an address the provider vouched for reaches identity, because identity
 * attaches by address and an unverified one would be a claim on somebody else's account.
 * Third, the *configuration gate*: a half-configured deployment refuses instead of starting
 * a walk that cannot come home.
 */
import {
  DependencyUnavailableException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import { createHash, createHmac } from 'node:crypto';
import { OAuthService } from '../src/application/oauth/oauth.service';
import { signOAuthState } from '../src/application/oauth/oauth-state';
import {
  EMAIL,
  FakeAccessControlClient,
  FakeIdentityClient,
  FakeOAuthHttp,
  FakeSessionClient,
  USER_ID,
  openOAuth,
  testGatewayConfig,
  userOf,
} from './testing/peer-doubles';

const walkWith = (oauth = openOAuth) => {
  const http = new FakeOAuthHttp();
  const identity = new FakeIdentityClient();
  const sessions = new FakeSessionClient();
  const accessControl = new FakeAccessControlClient();
  const service = new OAuthService(
    testGatewayConfig({ oauth }),
    http,
    identity,
    sessions,
    accessControl,
  );
  return { service, http, identity, sessions, accessControl };
};

const stateFor = (provider: 'google' | 'github'): string =>
  signOAuthState(provider, openOAuth.stateSecret);

/** A Telegram callback the fixture bot really signed — same algorithm, decided here. */
const telegramQueryFor = (
  fields: Record<string, string>,
  botToken: string = openOAuth.telegram!.botToken,
): Record<string, string | string[]> => {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return { ...fields, hash };
};

describe('OAuthService.providers', () => {
  it('reports every provider when the deployment is fully configured', () => {
    const { service } = walkWith();

    expect(service.providers()).toEqual({
      google: true,
      github: true,
      telegram: true,
      telegramBotUsername: 'front_test_bot',
    });
  });

  it('reports neither redirect provider nor the widget when nothing was configured', () => {
    const { service } = walkWith(testGatewayConfig().oauth);

    expect(service.providers()).toEqual({
      google: false,
      github: false,
      telegram: false,
      telegramBotUsername: null,
    });
  });
});

describe('OAuthService.start', () => {
  it('sends the browser to Google with a state this side can verify', () => {
    const { service } = walkWith();

    const url = new URL(service.start('google'));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(openOAuth.google!.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${openOAuth.publicOrigin}/api/auth/oauth/google/callback`,
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    // The state round-trips through the very secret the callback will check it with.
    expect(
      JSON.parse(
        Buffer.from(
          (url.searchParams.get('state') as string).split('.')[0] as string,
          'base64url',
        ).toString('utf8'),
      ),
    ).toMatchObject({ p: 'google' });
  });

  it('asks GitHub for the room where verified addresses live', () => {
    const { service } = walkWith();

    const url = new URL(service.start('github'));

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('state')).toContain('.');
  });

  it('refuses a provider this contract does not name, as a 404', () => {
    const { service } = walkWith();

    const error = (() => {
      try {
        service.start('twitter');
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ResourceNotFoundException);
    expect((error as ResourceNotFoundException).getStatus()).toBe(404);
  });

  it('refuses a known provider this deployment has no client pair for, as a 503', () => {
    const { service } = walkWith(testGatewayConfig().oauth);

    const error = (() => {
      try {
        service.start('github');
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(DependencyUnavailableException);
    expect((error as DependencyUnavailableException).getStatus()).toBe(503);
  });

  it('refuses even a complete client pair when the walk has no state secret', () => {
    // The gate is the pair of walk-level values, not the provider's: a client id without a
    // nonce signer would start a callback nobody could verify.
    const { service } = walkWith({ ...openOAuth, stateSecret: '' });

    expect(() => service.start('google')).toThrow(DependencyUnavailableException);
    // Telegram's gate is its own: the widget needs no state round trip, so a walk without
    // a nonce signer still offers it — what it needs is the bot, which this fixture has.
    expect(service.providers()).toEqual({
      google: false,
      github: false,
      telegram: true,
      telegramBotUsername: 'front_test_bot',
    });
  });

  it('refuses to start Telegram here — its widget opens the callback, so this is a 400', () => {
    const { service } = walkWith();

    const error = (() => {
      try {
        service.start('telegram');
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ValidationException);
    expect((error as ValidationException).getStatus()).toBe(400);
    // Distinct from an unknown provider's 404: this door exists, it is just not one you
    // walk through from a URL.
    expect((error as ValidationException).message).toContain('login widget');
  });
});

describe('OAuthService.callback for telegram', () => {
  const FIELDS = {
    id: '777000111',
    first_name: 'Ada',
    last_name: 'Lovelace',
    username: 'ada_lovelace',
    auth_date: String(Math.floor(Date.now() / 1000)),
  };

  it('verifies, resolves and issues — with no provider exchange in between', async () => {
    const { service, http, identity, sessions } = walkWith();

    const result = await service.callback({
      provider: 'telegram',
      telegramQuery: telegramQueryFor(FIELDS),
      ipAddress: '10.0.0.1',
    });

    // Telegram signs the payload instead of handing out a code, so nothing is exchanged.
    expect(http.posts).toEqual([]);
    expect(http.gets).toEqual([]);
    expect(identity.resolvedFor).toEqual([
      {
        provider: 'telegram',
        subject: '777000111',
        // The synthesized address: a namespace RFC 2606 reserves for exactly this —
        // syntactically real, structurally unroutable.
        email: '777000111@telegram.invalid',
        emailVerified: false,
        displayName: 'Ada Lovelace',
      },
    ]);
    expect(sessions.issued).toEqual([
      { userId: USER_ID, email: EMAIL, ipAddress: '10.0.0.1' },
    ]);
    expect(result).toEqual(sessions.issueResult);
  });

  it('gives a first-time OAuth account the baseline shopper role', async () => {
    const { service, identity, accessControl } = walkWith();
    identity.resolved = { user: userOf(), created: true };

    await service.callback({
      provider: 'telegram',
      telegramQuery: telegramQueryFor(FIELDS),
    });

    // Without this, a provider-created account would enter its first session with no role
    // at all — signed in, but unable to do what a signed-in shopper is promised.
    expect(accessControl.roleGrants).toEqual([
      { userId: USER_ID, role: 'user', grantedBy: 'oauth:telegram' },
    ]);
  });

  it('does not re-grant a role to an account that already existed', async () => {
    const { service, identity, accessControl } = walkWith();
    identity.resolved = { user: userOf(), created: false };

    await service.callback({
      provider: 'telegram',
      telegramQuery: telegramQueryFor(FIELDS),
    });

    expect(accessControl.roleGrants).toEqual([]);
  });

  it('refuses a payload whose fields were touched after signing', async () => {
    const { service, identity, sessions } = walkWith();
    const query = telegramQueryFor(FIELDS);
    const tampered = { ...query, first_name: 'Eve' };

    await expect(
      service.callback({ provider: 'telegram', telegramQuery: tampered }),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(identity.resolvedFor).toEqual([]);
    expect(sessions.issued).toEqual([]);
  });

  it('refuses a callback when no bot was configured', async () => {
    const { service, identity } = walkWith({ ...openOAuth, telegram: null });

    await expect(
      service.callback({ provider: 'telegram', telegramQuery: telegramQueryFor(FIELDS) }),
    ).rejects.toBeInstanceOf(DependencyUnavailableException);
    expect(identity.resolvedFor).toEqual([]);
  });

  it('refuses when the widget sent nothing to verify', async () => {
    const { service, identity } = walkWith();

    await expect(
      service.callback({ provider: 'telegram', telegramQuery: { id: '1' } }),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(identity.resolvedFor).toEqual([]);
  });
});

describe('OAuthService.callback', () => {
  it('verifies, exchanges, resolves and issues — in that order', async () => {
    const { service, http, identity, sessions } = walkWith();
    http.answerPost('https://oauth2.googleapis.com/token', { access_token: 'google-token' });
    http.answerGet('https://openidconnect.googleapis.com/v1/userinfo', {
      sub: 'subject-1',
      email: EMAIL,
      email_verified: true,
      name: 'Ada',
    });

    const result = await service.callback({
      provider: 'google',
      code: 'the-code',
      state: stateFor('google'),
      ipAddress: '10.0.0.1',
    });

    expect(http.posts).toHaveLength(1);
    expect(http.posts[0]!.form).toMatchObject({
      code: 'the-code',
      client_id: openOAuth.google!.clientId,
      client_secret: openOAuth.google!.clientSecret,
      grant_type: 'authorization_code',
      redirect_uri: `${openOAuth.publicOrigin}/api/auth/oauth/google/callback`,
    });
    expect(identity.resolvedFor).toEqual([
      {
        provider: 'google',
        subject: 'subject-1',
        email: EMAIL,
        emailVerified: true,
        displayName: 'Ada',
      },
    ]);
    expect(sessions.issued).toEqual([
      { userId: USER_ID, email: EMAIL, ipAddress: '10.0.0.1' },
    ]);
    expect(result).toEqual(sessions.issueResult);
  });

  it('refuses a foreign or forged state before spending the code', async () => {
    const { service, http, identity } = walkWith();

    // A state minted for the other provider: the signature is fine, the walk is not.
    await expect(
      service.callback({ provider: 'google', code: 'c', state: stateFor('github') }),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      service.callback({ provider: 'google', code: 'c', state: 'forged.state' }),
    ).rejects.toBeInstanceOf(ValidationException);
    await expect(
      service.callback({ provider: 'google', code: 'c', state: undefined }),
    ).rejects.toBeInstanceOf(ValidationException);

    // Nothing was sent to the provider and nobody was resolved.
    expect(http.posts).toEqual([]);
    expect(identity.resolvedFor).toEqual([]);
  });

  it('refuses a callback the provider answered without a code', async () => {
    const { service, http } = walkWith();

    await expect(
      service.callback({ provider: 'google', state: stateFor('google') }),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(http.posts).toEqual([]);
  });

  it('refuses an address Google has not vouched for', async () => {
    const { service, http, identity, sessions } = walkWith();
    http.answerPost('https://oauth2.googleapis.com/token', { access_token: 'google-token' });
    http.answerGet('https://openidconnect.googleapis.com/v1/userinfo', {
      sub: 'subject-1',
      email: 'unverified@example.test',
      email_verified: false,
    });

    const error = await service
      .callback({ provider: 'google', code: 'c', state: stateFor('google') })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationException);
    // The refusal happens before identity is asked anything: attaching by address on an
    // unverified claim would be account takeover with extra steps.
    expect(identity.resolvedFor).toEqual([]);
    expect(sessions.issued).toEqual([]);
  });

  it('reads GitHub through the verified list and prefers the primary address', async () => {
    const { service, http, identity } = walkWith();
    http.answerPost('https://github.com/login/oauth/access_token', {
      access_token: 'github-token',
    });
    http.answerGet('https://api.github.com/user/emails', [
      { email: 'old@example.test', primary: false, verified: false },
      { email: 'work@example.test', primary: false, verified: true },
      { email: EMAIL, primary: true, verified: true },
    ]);
    http.answerGet('https://api.github.com/user', {
      id: 42,
      login: 'octo',
      name: 'Ada Lovelace',
      email: null,
    });

    await service.callback({
      provider: 'github',
      code: 'c',
      state: stateFor('github'),
    });

    expect(identity.resolvedFor).toEqual([
      {
        provider: 'github',
        subject: '42',
        email: EMAIL,
        emailVerified: true,
        displayName: 'Ada Lovelace',
      },
    ]);
    // Both rooms were asked, with the same bearer.
    expect(http.gets.map((get) => get.bearer)).toEqual(['github-token', 'github-token']);
  });

  it('refuses GitHub when nothing on the list is verified', async () => {
    const { service, http, identity } = walkWith();
    http.answerPost('https://github.com/login/oauth/access_token', {
      access_token: 'github-token',
    });
    http.answerGet('https://api.github.com/user/emails', [
      { email: 'unverified@example.test', primary: true, verified: false },
    ]);
    http.answerGet('https://api.github.com/user', { id: 42, login: 'octo' });

    const error = await service
      .callback({ provider: 'github', code: 'c', state: stateFor('github') })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationException);
    expect(identity.resolvedFor).toEqual([]);
  });

  it('surfaces a provider-side refusal on the exchange as a stop, not a crash', async () => {
    const { service, http, identity } = walkWith();
    // GitHub's shape: 200 OK, the failure spelled out in the body.
    http.answerPost('https://github.com/login/oauth/access_token', {
      error: 'bad_verification_code',
    });

    const error = await service
      .callback({ provider: 'github', code: 'stale', state: stateFor('github') })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationException);
    expect((error as ValidationException).getStatus()).toBe(400);
    expect(identity.resolvedFor).toEqual([]);
  });

  it('reports an unreachable provider as the platform 503', async () => {
    const { service, http } = walkWith();
    http.postError = new DependencyUnavailableException(
      'the identity provider did not answer',
    );

    await expect(
      service.callback({ provider: 'google', code: 'c', state: stateFor('google') }),
    ).rejects.toBeInstanceOf(DependencyUnavailableException);
  });

  it('refuses to resolve anything when identity itself is unreachable', async () => {
    const { service, http, identity, sessions } = walkWith();
    http.answerPost('https://oauth2.googleapis.com/token', { access_token: 'google-token' });
    http.answerGet('https://openidconnect.googleapis.com/v1/userinfo', {
      sub: 'subject-1',
      email: EMAIL,
      email_verified: true,
    });
    identity.resolveError = new DependencyUnavailableException('identity did not answer');

    const error = await service
      .callback({ provider: 'google', code: 'c', state: stateFor('google') })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DependencyUnavailableException);
    expect(sessions.issued).toEqual([]);
  });
});

describe('landing', () => {
  it('puts a finished walk in the fragment of the front origin', () => {
    const { service } = walkWith();

    const url = new URL(
      service.successRedirect({
        accessToken: 'a',
        refreshToken: 'r',
        expiresIn: 900,
        sessionId: 's-1',
      }),
    );

    expect(url.origin).toBe(openOAuth.publicOrigin);
    expect(url.hash).toContain('access_token=a');
    expect(url.hash).toContain('refresh_token=r');
    expect(url.hash).toContain('expires_in=900');
    expect(url.hash).toContain('session_id=s-1');
    // A fragment, not a query: the part no server ever sees.
    expect(url.search).toBe('');
  });

  it('relays this platform\u2019s own refusal, and a fixed line for anything else', () => {
    const { service } = walkWith();

    const authored = new ValidationException('the sign-in could not be verified');
    expect(service.failureRedirect(authored)).toContain('the+sign-in+could+not+be+verified');

    expect(service.failureRedirect(new Error('socket internals'))).toContain(
      'the+sign-in+could+not+be+completed',
    );
    expect(service.failureRedirect(new Error('socket internals'))).not.toContain('socket');
  });
});
