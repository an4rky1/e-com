/**
 * @fileoverview The browser's walk to an identity provider and back, as one use case.
 *
 * @remarks Three phases, each owned elsewhere: *start* mints a signed `state` and hands the
 * browser a provider URL; *callback* verifies that state, exchanges the code, reads the
 * provider's word about who this is, and asks identity what that means locally; *land*
 * composes the redirect the browser follows home with the session in the fragment. Nothing
 * here decides whether a provider account maps to a user — that is identity's rule — and
 * nothing here can mint a token without both the provider's exchange and identity's answer.
 *
 * @remarks **The provider-specific parts live in `providers/`, one spec per name, and this
 * service holds none of them.** It validates the name against the contract, dispatches to
 * the spec's `start`/`callback`, and owns the two steps every provider converges on:
 * resolving the vouched-for profile against identity, and issuing the session. That split
 * is what makes the three providers one style: Telegram is a spec without a `start` field
 * rather than a branch, and adding a fourth provider touches the table, not this file.
 *
 * @remarks **Only a provider-vouched, verified address is ever accepted.** identity attaches
 * a provider account to whoever already owns an address, so an address the provider has
 * *not* vouched for would be a way to claim somebody else's account. The verification
 * requirement is enforced inside each spec — Google through `email_verified`, GitHub through
 * its `user:email` list, Telegram by synthesizing an address in the `.invalid` namespace
 * with `emailVerified: false` — before identity is asked anything.
 *
 * @remarks The landing URLs put the pair in the URL *fragment*. A fragment never reaches a
 * server, so the tokens travel browser-local from the callback page to the page that adopts
 * them — and the landing page strips it with `history.replaceState` the moment it has read
 * it, so it does not sit in history either. The alternative, a cookie set through the proxy,
 * would put session semantics in the rewrite layer, which is a worse place for them.
 */
import { Inject, Injectable } from '@nestjs/common';
import { isOAuthProvider, type OAuthProvidersResponse } from '@auth/contracts/http';
import {
  AppException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import { GATEWAY_CONFIG, type GatewayConfig } from '../../gateway.config';
import type { LoginResult } from '../facade/gateway.service';
import {
  IDENTITY_CLIENT,
  SESSION_CLIENT,
  type IdentityClientPort,
  type SessionClientPort,
} from '../ports/peer-clients.port';
import { OAUTH_HTTP, type OAuthHttpPort } from './oauth.port';
import {
  OAUTH_PROVIDER_SPECS,
  providerSpecOf,
  telegramBotUsernameOf,
  type OAuthProviderSpec,
} from './providers';

@Injectable()
export class OAuthService {
  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    @Inject(OAUTH_HTTP) private readonly http: OAuthHttpPort,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityClientPort,
    @Inject(SESSION_CLIENT) private readonly sessions: SessionClientPort,
  ) {}

  /**
   * Which providers this deployment can start — the front reads it before drawing a button,
   * so an unconfigured provider is an absent button rather than a dead walk.
   *
   * @remarks The response shape is the published contract (`telegram` plus a flat
   * `telegramBotUsername`), so the widget's extra field stays a field here even though the
   * table behind it is uniform: a contract outlives the code that first served it, and the
   * front reading this endpoint is not part of this repository's compile.
   */
  providers(): OAuthProvidersResponse {
    const telegramBotUsername = telegramBotUsernameOf(this.config);
    return {
      google: OAUTH_PROVIDER_SPECS.google.available(this.config),
      github: OAUTH_PROVIDER_SPECS.github.available(this.config),
      telegram: OAUTH_PROVIDER_SPECS.telegram.available(this.config),
      telegramBotUsername,
    };
  }

  /**
   * The URL the browser is sent to, or a refusal when the walk cannot start.
   *
   * @remarks Two distinct refusals: a provider this contract does not name is a 404 — there
   * is no such door — while a known provider this deployment has no client pair for is a
   * 503: the door exists, the operator has not furnished it yet. A third, a provider with
   * no start route at all (the widget providers), is a 400: the provider is real and its
   * entry point simply lives on the front's page, not behind a URL here.
   */
  start(provider: string, now: Date = new Date()): string {
    const spec = this.specOf(provider);
    if (spec.start === undefined) {
      // Not a 404: sending a browser to a URL that cannot continue would be a slower way
      // of saying that the widget opens the callback.
      throw new ValidationException(
        `${spec.name} has no start route — its login widget opens the callback`,
        { provider: spec.name },
      );
    }
    return spec.start(this.config, now);
  }

  /**
   * Completes the walk: verify (in the spec), resolve, issue.
   *
   * @remarks The order is not interchangeable. The spec verifies before this service hears
   * the profile, identity is asked only after the provider has vouched, and tokens come
   * last — so a failure at any earlier step leaves no session behind. Two calls to identity
   * and the session service, the same two for every provider, because a provider-specific
   * branch here would be a provider-specific chance to skip one of them.
   */
  async callback(input: {
    provider: string;
    code?: string;
    state?: string;
    /** The raw callback query — Telegram's signed fields are read out of it, unmodified. */
    telegramQuery?: Record<string, string | string[]>;
    ipAddress?: string;
  }): Promise<LoginResult> {
    const spec = this.specOf(input.provider);

    const profile = await spec.callback(input, { config: this.config, http: this.http });

    const { user } = await this.identity.resolveOauthUser({
      provider: spec.name,
      subject: profile.subject,
      email: profile.email,
      emailVerified: profile.emailVerified,
      displayName: profile.displayName,
    });

    return this.sessions.issueTokens({
      userId: user.id,
      email: user.email,
      ipAddress: input.ipAddress,
    });
  }

  /**
   * Where a finished walk lands: the front's own origin, tokens in the fragment.
   *
   * @remarks The fragment is the one part of a URL that stays browser-local, which is what
   * makes this a redirect and not a hand-off to every server that logs a request line.
   */
  successRedirect(result: LoginResult): string {
    const params = new URLSearchParams({
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: String(result.expiresIn),
      session_id: result.sessionId,
    });
    return `${this.origin()}/#${params.toString()}`;
  }

  /**
   * Where a failed walk lands: the refusal, in the fragment, for the page to show.
   *
   * @remarks Only this platform's own exception messages are relayed — they are written to
   * be shown. Anything else becomes the fixed line, because an unexpected error's message is
   * exactly the sort of text that should not be echoed into a browser.
   */
  failureRedirect(error: unknown): string {
    const message =
      error instanceof AppException && typeof error.message === 'string'
        ? error.message
        : 'the sign-in could not be completed';
    const params = new URLSearchParams({ oauth_error: message });
    return `${this.origin()}/#${params.toString()}`;
  }

  /**
   * Narrows a path parameter to the providers the contract names, or refuses it.
   *
   * @remarks One check for `start` and `callback` alike: a name the contract does not carry
   * is a 404 in either route, and validating here rather than inside each spec keeps "is
   * this provider ours" in one place — the table is only ever addressed with a real name.
   */
  private specOf(provider: string): OAuthProviderSpec {
    if (!isOAuthProvider(provider)) {
      throw new ResourceNotFoundException('unknown oauth provider', {
        provider: provider.slice(0, 32),
      });
    }
    return providerSpecOf(provider);
  }

  private origin(): string {
    return this.config.oauth.publicOrigin.replace(/\/+$/, '');
  }
}
