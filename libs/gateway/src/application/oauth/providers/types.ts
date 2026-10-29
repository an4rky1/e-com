/**
 * @fileoverview The shape every identity provider in this edge implements.
 *
 * @remarks One interface for three providers is the point of this directory. Google, GitHub
 * and Telegram reach a session by genuinely different routes — two walk a signed redirect
 * round trip, one posts an HMAC from a widget the front rendered — but the edge asks each
 * of them the same three questions: *are you configured*, *where does the browser start*,
 * *who did the provider say this is*. A spec answers those three; everything downstream
 * (resolve against identity, issue tokens, land the browser) never learns which question
 * differed.
 *
 * @remarks The asymmetry that remains is honest and stays visible: `start` is optional,
 * because a provider whose own widget renders the entry point has no URL here. Making that
 * a `throw` inside a `start` implementation instead of an absent field would answer "has a
 * start route" with a runtime failure where the type system can answer it statically.
 */
import type { OAuthProvider } from '@auth/contracts/http';
import type { GatewayConfig } from '../../../gateway.config';
import type { OAuthHttpPort } from '../oauth.port';

/** What a provider said about the account, after the verification requirement is applied. */
export interface OAuthProfile {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
}

/**
 * The callback as the controller hands it over — the raw query, unshaped.
 *
 * @remarks Every field is optional because no two providers need the same subset: the walk
 * providers take `state` and `code`, the widget provider takes its signed fields under
 * `telegramQuery`. Each spec reads only what it signed up for and ignores the rest, which
 * is why the service can pass one object to all three without a per-provider branch.
 */
export interface ProviderCallbackInput {
  readonly code?: string;
  readonly state?: string;
  /** The raw callback query — Telegram's signed fields are read out of it, unmodified. */
  readonly telegramQuery?: Record<string, string | string[]>;
  readonly ipAddress?: string;
}

/** What a spec may reach while answering; nothing else from the service leaks in. */
export interface ProviderContext {
  readonly config: GatewayConfig;
  readonly http: OAuthHttpPort;
}

/**
 * One identity provider, in the form the service dispatches to.
 *
 * @remarks `available` gates the button, `start` (when present) is the browser's first hop,
 * `callback` ends with a verified {@link OAuthProfile} and nothing else — no identity
 * lookup, no token. Keeping resolution and issuance in the service is what makes the three
 * providers converge on one sign-in path instead of three.
 */
export interface OAuthProviderSpec {
  readonly name: OAuthProvider;

  /**
   * Whether this deployment can run the provider at all.
   *
   * @remarks Re-derived from config on every call rather than cached: an operator's change
   * to the environment must not be shadowed by a boot-time snapshot on an edge process
   * whose whole job is to reflect what its peers currently say.
   */
  available(config: GatewayConfig): boolean;

  /**
   * The URL the browser is sent to.
   *
   * @remarks Absent for widget providers: their entry point is rendered by the front, and
   * the service turns the absence into the same 400 the previous code threw — a provider
   * known to the contract that simply has no door *here*.
   */
  readonly start?: (config: GatewayConfig, now: Date) => string;

  /**
   * Verifies the provider's word and returns who it vouches for.
   *
   * @remarks Verification is the first thing this does, inside the spec: for the walk it is
   * the `state` checked before the code is spent, for the widget it is the HMAC checked
   * before identity hears about the payload. The service never sees an unverified profile.
   */
  callback(input: ProviderCallbackInput, ctx: ProviderContext): Promise<OAuthProfile>;
}

/** The providers that walk the redirect round trip; Telegram is the one that does not. */
export type RedirectProviderName = Exclude<OAuthProvider, 'telegram'>;

/** JSON that should be an object — an array or a scalar is not a profile document. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
