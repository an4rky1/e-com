/**
 * @fileoverview The provider table: one entry per name in the contract's `OAUTH_PROVIDERS`.
 *
 * @remarks The `satisfies` clause is the load-bearing part. Adding a fourth name to
 * `OAUTH_PROVIDERS` in `@auth/contracts/http` fails to compile until this table carries a
 * spec for it — the contract and the dispatch cannot drift, because a provider the front
 * may draw a button for but the service cannot dispatch to would be a dead walk discovered
 * by a user instead of by the compiler.
 *
 * @remarks Telegram sits in the same table as the walk providers on purpose. Its
 * differences — no `start`, an HMAC instead of an exchange — are *fields of its spec*,
 * not branches in the service; that is what "same style" means here: every provider is
 * reached by the same three operations, and a provider that answers one differently says
 * so in its own file.
 */
import type { OAuthProvider } from '@auth/contracts/http';
import { githubProvider } from './github';
import { googleProvider } from './google';
import { telegramProvider } from './telegram';
import type { OAuthProviderSpec } from './types';

export const OAUTH_PROVIDER_SPECS = {
  google: googleProvider,
  github: githubProvider,
  telegram: telegramProvider,
} as const satisfies Record<OAuthProvider, OAuthProviderSpec>;

/** The spec behind a name the contract has already validated. */
export function providerSpecOf(provider: OAuthProvider): OAuthProviderSpec {
  return OAUTH_PROVIDER_SPECS[provider];
}

export { githubProvider } from './github';
export { googleProvider } from './google';
export { telegramBotOrNull, telegramBotUsernameOf, telegramProvider } from './telegram';
export { originOf, redirectProvider, type ProviderEndpoints } from './redirect';
export type {
  OAuthProfile,
  OAuthProviderSpec,
  ProviderCallbackInput,
  ProviderContext,
  RedirectProviderName,
} from './types';
