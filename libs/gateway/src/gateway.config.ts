/**
 * @fileoverview The `GATEWAY_` namespace for the api-gateway.
 *
 * @remarks `process.env` appears in exactly one function of this library. Everything else
 * takes a resolved {@link GatewayConfig}, which is what lets a suite build a config — a
 * 50 ms deadline, a peer on `127.0.0.1:1` — without mutating global state.
 *
 * @remarks **There is no `DATABASE_URL` here, and that is the design.** An edge that can be
 * pointed at a connection string is an edge that can be pointed at somebody else's state. The
 * key is absent from the schema, so `readNamespacedEnv` cannot produce one even if the process
 * has one set — and the service still boots when the variable is missing, which is the test
 * that proves the edge is stateless.
 *
 * @remarks **One secret here verifies a token: {@link GatewayConfig.accessTokenSigningKey}.**
 * The edge checks the access token's signature locally on every request instead of asking
 * session — one HMAC, no peer call, no per-request lookup — which is what makes this
 * process stateless. The key is read from the `SESSION_` namespace (`SESSION_ACCESS_TOKEN_`
 * `SIGNING_KEY`), the very variable the session service signs with, in the same way
 * `GRPC_SERVICE_TOKEN` is read from the namespace every peer shares: a `GATEWAY_`-prefixed
 * twin would be a second secret for one trust boundary, and a rotation that updated this edge
 * out of step with the services it calls — the failure mode being a token that mints fine and
 * refuses at the edge. The edge holds it to verify and never to mint: nothing in this service
 * signs a token.
 *
 * @remarks The price of verifying locally is that a *revoked* session does not invalidate an
 * access token that is already in the wild: logout kills the session row, so the next refresh
 * fails, but the bearer lives until its `exp` (15 minutes). That trade was chosen deliberately
 * — stateless edge, short blast radius — and the other platform secrets this service holds
 * ({@link GatewayConfig.grpcServiceToken}, {@link GatewayConfig.stateSecret}, the OAuth client
 * pairs) are held to be presented, never to mint a session either.
 *
 * @remarks Every `OAUTH_*` value defaults to the empty string, and empty means *disabled* —
 * the state secret and the public origin gate the whole walk, and a client pair without them
 * is a provider nobody may start. That is deliberate: an unconfigured deployment must boot,
 * and a provider that is half-configured must refuse rather than send a browser into a
 * callback that cannot complete.
 */
import { z } from 'zod';
import {
  envInt,
  envSecret,
  envString,
  readNamespacedEnv,
  resolveModuleConfig,
} from '@auth/platform/config';
import { readServiceToken } from '@auth/infra/grpc';

/** The resolved namespace, injected everywhere instead of a module-level read. */
export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');

export const Defaults = {
  /**
   * Absolute deadline on one outbound gRPC call.
   *
   * @remarks The edge is the only hop in front of every other service, so it is where a slow
   * dependency has to stop rather than accumulate. Three seconds is short enough that a
   * caller sees a `DEPENDENCY_UNAVAILABLE` while the request still has a browser's worth of
   * patience left.
   */
  PEER_DEADLINE_MS: 3_000,
  /**
   * Peer addresses, defaulting to the ports each service's `main.ts` binds by default.
   *
   * @remarks These are the same numbers the per-service `main.ts` files use for `GRPC_URL`,
   * so an unmodified deployment needs no gateway-specific configuration at all.
   */
  IDENTITY_URL: 'localhost:13001',
  ACCESS_CONTROL_URL: 'localhost:13002',
  CREDENTIAL_VAULT_URL: 'localhost:13003',
  SESSION_URL: 'localhost:13004',
  AUTH_FLOW_URL: 'localhost:13005',
  /**
   * Tolerance applied to `exp` when the edge verifies a token.
   *
   * @remarks The same default and the same variable (`SESSION_CLOCK_SKEW_SEC`) as the
   * issuer: two verifiers with different clocks is the "logged out for no reason" bug, and
   * two verifiers with different *tolerances* is the same bug wearing a config file.
   */
  CLOCK_SKEW_SEC: 30,
} as const;

export const gatewaySchema = z.object({
  PEER_DEADLINE_MS: envInt(Defaults.PEER_DEADLINE_MS, { min: 100, max: 30_000 }),
  IDENTITY_URL: envString(Defaults.IDENTITY_URL),
  ACCESS_CONTROL_URL: envString(Defaults.ACCESS_CONTROL_URL),
  CREDENTIAL_VAULT_URL: envString(Defaults.CREDENTIAL_VAULT_URL),
  SESSION_URL: envString(Defaults.SESSION_URL),
  AUTH_FLOW_URL: envString(Defaults.AUTH_FLOW_URL),
  // The OAuth walk. All eight default to empty — see the header: empty disables, and an
  // unconfigured deployment boots without a provider rather than with a broken one.
  OAUTH_PUBLIC_ORIGIN: envString(''),
  OAUTH_STATE_SECRET: envString(''),
  OAUTH_GOOGLE_CLIENT_ID: envString(''),
  OAUTH_GOOGLE_CLIENT_SECRET: envString(''),
  OAUTH_GITHUB_CLIENT_ID: envString(''),
  OAUTH_GITHUB_CLIENT_SECRET: envString(''),
  OAUTH_TELEGRAM_BOT_TOKEN: envString(''),
  OAUTH_TELEGRAM_BOT_USERNAME: envString(''),
});

export type GatewayEnvConfig = z.infer<typeof gatewaySchema>;

/**
 * The session namespace, read a second time by this process.
 *
 * @remarks Mirrors the `session` service's own schema for exactly two keys: the key that signs
 * access tokens and the skew applied to `exp`. Both sides must agree on both — a shared
 * signing key with two readings of it, or one skew and not the other, is the edge refusing
 * what the issuer considers a live token. Everything else in that namespace (TTLs, family
 * deadlines, the reuse switch) is issuance policy and deliberately invisible here.
 */
export const sessionTrustSchema = z.object({
  ACCESS_TOKEN_SIGNING_KEY: envSecret('SESSION_ACCESS_TOKEN_SIGNING_KEY'),
  CLOCK_SKEW_SEC: envInt(Defaults.CLOCK_SKEW_SEC, { min: 0, max: 300 }),
});

export type SessionTrustEnvConfig = z.infer<typeof sessionTrustSchema>;

/** One identity provider's credentials at that provider. */
export interface OAuthProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Telegram's login widget is keyed by a bot rather than an OAuth client.
 *
 * @remarks The token both identifies the widget's `data-telegram-login` and keys the HMAC
 * that signs every callback back; the username is what the widget renders with. Neither is
 * a secret in the client-id sense — but the token is, and a leaked one lets anyone mint
 * apparently genuine sign-ins for this deployment.
 */
export interface TelegramOAuthConfig {
  readonly botToken: string;
  readonly botUsername: string;
}

export interface OAuthConfig {
  /**
   * The origin the browser knows — where callbacks come back to.
   *
   * @remarks Deliberately separate from `GATEWAY_URL`: the browser reaches the gateway
   * *through* the front's proxy, so the redirect URI the provider is told about is
   * `${publicOrigin}/api/auth/oauth/...` — the front's origin, not the gRPC-facing address
   * this process listens on.
   */
  readonly publicOrigin: string;
  /**
   * Signs the OAuth `state` parameter.
   *
   * @remarks A CSRF nonce for the browser's round trip, not a session key: its payload is a
   * provider name and an expiry, and carrying it says nothing about any user. Present for the
   * exchange, verified as a nonce, never usable to mint a token.
   */
  readonly stateSecret: string;
  readonly google: OAuthProviderConfig | null;
  readonly github: OAuthProviderConfig | null;
  /** The Telegram widget's bot pair, null until both values and an origin exist. */
  readonly telegram: TelegramOAuthConfig | null;
}

export interface GatewayConfig {
  /** Absolute deadline applied to every outbound call. */
  readonly peerDeadlineMs: number;
  readonly identityUrl: string;
  readonly accessControlUrl: string;
  readonly credentialVaultUrl: string;
  readonly sessionUrl: string;
  readonly authFlowUrl: string;
  /** The OAuth walk, resolved to null providers until an operator configures one. */
  readonly oauth: OAuthConfig;
  /**
   * The platform service token, placed in `x-service-token` on every peer call.
   *
   * @remarks Read from `GRPC_SERVICE_TOKEN` rather than from a `GATEWAY_` variable: the same
   * secret admits a call on every service, so a gateway-only name would be a second secret for
   * one trust boundary — and a rotation that updated nine services out of ten.
   */
  readonly grpcServiceToken: string;
  /**
   * Verifies the signature of every access token this edge accepts.
   *
   * @remarks The same value the session service signs with, read from the same `SESSION_`
   * variable. Verification is local and synchronous: `JwtAuthGuard` never opens a connection
   * to answer "is this bearer genuine".
   */
  readonly accessTokenSigningKey: string;
  /** Tolerance applied to `exp`, in seconds — the issuer's value, read from its namespace. */
  readonly clockSkewSec: number;
}

/**
 * What token verification actually needs from the config.
 *
 * @remarks The guard depends on the slice, not the whole: two fields are what it reads, and a
 * constructor that says so lets a unit test hand it two fields instead of a full edge topology.
 */
export type GatewayTokenTrust = Pick<GatewayConfig, 'accessTokenSigningKey' | 'clockSkewSec'>;

/** proto package -> address, which is the shape `createStaticGrpcChannel` expects. */
export function peerAddressesOf(config: GatewayConfig): Record<string, string> {
  return {
    'identity.v1': config.identityUrl,
    'access_control.v1': config.accessControlUrl,
    'credential_vault.v1': config.credentialVaultUrl,
    'session.v1': config.sessionUrl,
    'auth_flow.v1': config.authFlowUrl,
  };
}

/**
 * Reads the `GATEWAY_` namespace into a validated config.
 *
 * @remarks `env` is a parameter so a test never reaches into `process.env`, and so the same
 * resolver serves the boot path and a fixture.
 */
export function resolveGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const parsed = readNamespacedEnv('GATEWAY', gatewaySchema, env);

  // Order matters for the boot error: the service token is read first, so an empty
  // environment names the one secret every deployment must have before it names the second.
  const grpcServiceToken = readServiceToken(env);
  // Third read of the same `env`, in the issuer's namespace: the key that signs access
  // tokens and the skew applied to `exp`, both owned by the session service and required here —
  // an edge that cannot verify a bearer would refuse every authenticated request anyway,
  // just later and one by one.
  const trust = readNamespacedEnv('SESSION', sessionTrustSchema, env);

  return resolveModuleConfig<GatewayConfig>(
    {
      peerDeadlineMs: parsed.PEER_DEADLINE_MS,
      identityUrl: parsed.IDENTITY_URL,
      accessControlUrl: parsed.ACCESS_CONTROL_URL,
      credentialVaultUrl: parsed.CREDENTIAL_VAULT_URL,
      sessionUrl: parsed.SESSION_URL,
      authFlowUrl: parsed.AUTH_FLOW_URL,
      oauth: resolveOAuthConfig(parsed),
      grpcServiceToken,
      accessTokenSigningKey: trust.ACCESS_TOKEN_SIGNING_KEY,
      clockSkewSec: trust.CLOCK_SKEW_SEC,
    },
    {},
  );
}

/**
 * Resolves the provider table from raw values, with empty meaning off.
 *
 * @remarks One gate for the redirect walk: without a public origin there is no redirect URI
 * to give the provider, and without a state secret the `state` round trip is unsigned — so
 * both being set is what allows *any* of its providers, and a client pair alone is never
 * enough. A half-configured provider therefore resolves to `null`, which the routes report
 * as "not available" instead of starting a flow that cannot come home.
 *
 * @remarks Telegram's gate is narrower on purpose: its widget never starts here, so there is
 * no round trip for a `state` to protect — the callback's own HMAC is the tie. It still
 * needs the origin (the landing after verification) and *both* bot values, because the
 * username is what the widget renders with and a button that cannot render is a dead walk.
 */
function resolveOAuthConfig(parsed: GatewayEnvConfig): OAuthConfig {
  const walkReady =
    parsed.OAUTH_PUBLIC_ORIGIN !== '' && parsed.OAUTH_STATE_SECRET !== '';
  const pairOf = (clientId: string, clientSecret: string): OAuthProviderConfig | null =>
    walkReady && clientId !== '' && clientSecret !== ''
      ? { clientId, clientSecret }
      : null;
  const telegram =
    parsed.OAUTH_PUBLIC_ORIGIN !== '' &&
    parsed.OAUTH_TELEGRAM_BOT_TOKEN !== '' &&
    parsed.OAUTH_TELEGRAM_BOT_USERNAME !== ''
      ? {
          botToken: parsed.OAUTH_TELEGRAM_BOT_TOKEN,
          botUsername: parsed.OAUTH_TELEGRAM_BOT_USERNAME,
        }
      : null;

  return {
    publicOrigin: parsed.OAUTH_PUBLIC_ORIGIN,
    stateSecret: parsed.OAUTH_STATE_SECRET,
    google: pairOf(parsed.OAUTH_GOOGLE_CLIENT_ID, parsed.OAUTH_GOOGLE_CLIENT_SECRET),
    github: pairOf(parsed.OAUTH_GITHUB_CLIENT_ID, parsed.OAUTH_GITHUB_CLIENT_SECRET),
    telegram,
  };
}
