/**
 * @fileoverview The redirect walk, as one spec factory for every provider that takes it.
 *
 * @remarks Google and GitHub differ in three places only — where to send the browser, how
 * to spend the code, where to read the address — and agree on everything else: a signed
 * `state` checked before the code is spent, a refusal when the address the provider reports
 * was never vouched for, the same resolve-and-issue downstream. Encoding that agreement
 * once here is what makes a future redirect provider a table entry rather than another
 * branch of `OAuthService`.
 *
 * @remarks Telegram is deliberately *not* produced by this factory: it has no `state` to
 * sign (its callback carries an HMAC keyed by the bot token instead) and no code to
 * exchange, so it is a different spec, not a special case of this one — see `telegram.ts`.
 *
 * @remarks The order inside `callback` is not interchangeable. The deployment's own client
 * pair is checked first (a walk this deployment cannot complete must not spend a code),
 * then the `state` — so a replayed or forged callback costs the provider exchange nothing —
 * and only then the code, the profile, and, back in the service, identity's answer.
 */
import { DependencyUnavailableException, ValidationException } from '@auth/platform/error-handling';
import { ApiRoutes, viaOAuth } from '@auth/contracts/http';
import { signOAuthState, verifyOAuthState } from '../oauth-state';
import type { GatewayConfig, OAuthProviderConfig } from '../../../gateway.config';
import {
  asRecord,
  type OAuthProfile,
  type OAuthProviderSpec,
  type ProviderContext,
  type RedirectProviderName,
} from './types';

/** Where a provider's four rooms are, and what it wants in the URL. */
export interface ProviderEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly profileUrl: string;
  /**
   * GitHub keeps the address off `/user` unless asked — `user:email` is the room where the
   * verified list lives, and the list is what this walk reads rather than the summary field.
   */
  readonly emailsUrl?: string;
  readonly scope: string;
}

export interface RedirectProviderOptions {
  readonly name: RedirectProviderName;
  readonly endpoints: ProviderEndpoints;
  /**
   * Extra authorize parameters. Spelled out for Google; GitHub's endpoint presumes the
   * default and ignores them, so the absent entry is a decision rather than an omission.
   */
  readonly authorizeQuery?: Readonly<Record<string, string>>;
  /** Extra token-form fields — Google wants `grant_type`, GitHub presumes the default. */
  readonly tokenForm?: Readonly<Record<string, string>>;
  /**
   * The provider's own reading of the profile document.
   *
   * @remarks Returns a profile *after* this provider's verification requirement — Google's
   * `email_verified` claim, GitHub's verified-address list. A provider that has not vouched
   * for the address must refuse here, before identity is asked to link anything to it.
   */
  readonly profileOf: (
    ctx: ProviderContext,
    endpoints: ProviderEndpoints,
    accessToken: string,
    body: Record<string, unknown>,
  ) => OAuthProfile | Promise<OAuthProfile>;
}

/** Builds a redirect-walk spec. See the file overview for what it unifies. */
export function redirectProvider(options: RedirectProviderOptions): OAuthProviderSpec {
  const { name, endpoints } = options;

  /**
   * The walk-level gate.
   *
   * @remarks `resolveGatewayConfig` already refuses a half-configured walk, but a config
   * built by hand — a fixture, a future embedder — must hit the same wall: a client pair
   * without an origin has no redirect URI to give the provider, and one without a state
   * secret would start a callback nobody could verify.
   */
  const clientOrNull = (config: GatewayConfig): OAuthProviderConfig | null => {
    const { publicOrigin, stateSecret } = config.oauth;
    if (publicOrigin === '' || stateSecret === '') return null;
    return config.oauth[name];
  };

  const clientOf = (config: GatewayConfig): OAuthProviderConfig => {
    const client = clientOrNull(config);
    if (client === null) {
      throw new DependencyUnavailableException('oauth provider is not configured', { provider: name });
    }
    return client;
  };

  /** The callback as the *provider* must know it: the front's origin, trimmed. */
  const redirectUriOf = (config: GatewayConfig): string =>
    `${originOf(config)}${viaOAuth(ApiRoutes.oauthCallback, name)}`;

  const exchange = async (
    client: OAuthProviderConfig,
    code: string,
    ctx: ProviderContext,
  ): Promise<string> => {
    const body = await ctx.http.postForm(endpoints.tokenUrl, {
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUriOf(ctx.config),
      ...(options.tokenForm ?? {}),
    });

    const record = asRecord(body);
    if (record === null) {
      throw new ValidationException('the identity provider refused the sign-in', { provider: name });
    }
    // GitHub answers 200 with the failure in the body; Google fails with a status. Both
    // arrive here as one check, because both spell the outcome `error`.
    if (typeof record.error === 'string' && record.error.length > 0) {
      throw new ValidationException('the identity provider refused the sign-in code', {
        provider: name,
        detail: record.error.slice(0, 64),
      });
    }
    if (typeof record.access_token !== 'string' || record.access_token.length === 0) {
      throw new ValidationException('the identity provider returned no access token', { provider: name });
    }
    return record.access_token;
  };

  return {
    name,

    available: (config) => clientOrNull(config) !== null,

    start: (config, now) => {
      const client = clientOf(config);
      const state = signOAuthState(name, config.oauth.stateSecret, now);

      const url = new URL(endpoints.authorizeUrl);
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', redirectUriOf(config));
      url.searchParams.set('scope', endpoints.scope);
      url.searchParams.set('state', state);
      for (const [key, value] of Object.entries(options.authorizeQuery ?? {})) {
        url.searchParams.set(key, value);
      }
      return url.toString();
    },

    callback: async (input, ctx) => {
      const client = clientOf(ctx.config);

      const claims = verifyOAuthState(input.state, ctx.config.oauth.stateSecret);
      if (claims === null || claims.provider !== name) {
        // One refusal for "forged", "expired" and "another tab's": the caller's answer is
        // verify-or-stop either way, and the differences are only useful to whoever failed.
        throw new ValidationException('the sign-in could not be verified', { provider: name });
      }
      if (typeof input.code !== 'string' || input.code.length === 0) {
        throw new ValidationException('the provider did not return a sign-in code', { provider: name });
      }

      const accessToken = await exchange(client, input.code, ctx);

      const body = asRecord(await ctx.http.getJson(endpoints.profileUrl, accessToken));
      if (body === null) {
        throw new ValidationException('the provider did not describe the account', { provider: name });
      }
      return await options.profileOf(ctx, endpoints, accessToken, body);
    },
  };
}

/** The origin the browser knows, with trailing slashes trimmed so providers match allow-lists. */
export function originOf(config: GatewayConfig): string {
  return config.oauth.publicOrigin.replace(/\/+$/, '');
}
