/**
 * @fileoverview Telegram's half of the sign-in: the widget provider, as a spec like any other.
 *
 * @remarks Telegram walks no redirect: there is no consent screen here, no `state` to mint
 * and no code to exchange. The front renders Telegram's own widget, which posts the browser
 * straight to the callback carrying `id`, names, `auth_date` and an HMAC keyed by the bot
 * token — so this spec has no `start` field, and that absence, not a branch somewhere else,
 * is what tells the service the widget *is* the start. Everything after verification —
 * resolve against identity, issue tokens, land the browser — is the same path the redirect
 * providers take, and lives in the service.
 *
 * @remarks **The address is synthesized, because Telegram has none to give.** identity
 * looks accounts up by address — that is how a password sign-in and a Google one meet on
 * the same user — so a Telegram account needs one too. It is built in the `.invalid`
 * namespace (RFC 2606): syntactically a real address, structurally one no mail server will
 * ever accept, so nothing in this platform can mistake it for a mailbox worth writing to,
 * and `emailVerified: false` records that no address was ever proven — what was proven is
 * the numeric id, which is the subject the account links on.
 */
import { DependencyUnavailableException, ValidationException } from '@auth/platform/error-handling';
import { verifyTelegramAuth } from '../telegram-auth';
import type { GatewayConfig, TelegramOAuthConfig } from '../../../gateway.config';
import type { OAuthProviderSpec } from './types';

/**
 * Telegram's bot pair, or null until the deployment can actually run the widget.
 *
 * @remarks The same wall the redirect providers build around their client pair, from
 * Telegram's own materials: an origin to land the browser on after verification, and both
 * bot values — the token the callback's HMAC is keyed with, and the username without which
 * the front cannot render the widget that starts the whole thing.
 */
export function telegramBotOrNull(config: GatewayConfig): TelegramOAuthConfig | null {
  const { publicOrigin, telegram } = config.oauth;
  if (publicOrigin === '' || telegram === null) return null;
  if (telegram.botToken === '' || telegram.botUsername === '') return null;
  return telegram;
}

/**
 * What the front's widget renders with, or null when the button must not be drawn.
 *
 * @remarks Read through this function rather than by reaching into the config: the button
 * and the verification read the *same* gate, so a widget can never be drawn by a deployment
 * whose callback would then refuse it.
 */
export function telegramBotUsernameOf(config: GatewayConfig): string | null {
  return telegramBotOrNull(config)?.botUsername ?? null;
}

export const telegramProvider: OAuthProviderSpec = {
  name: 'telegram',

  available: (config) => telegramBotOrNull(config) !== null,

  // No `start`: the widget on the front's page is where a Telegram sign-in begins. The
  // service turns this absence into a 400 rather than a 404 — the provider is real, it
  // simply has no door *here*, and sending a browser to a URL that cannot continue would
  // be a slower way of saying so.

  callback: async (input, ctx) => {
    const bot = telegramBotOrNull(ctx.config);
    if (bot === null) {
      throw new DependencyUnavailableException('oauth provider is not configured', {
        provider: 'telegram',
      });
    }

    // The HMAC over the payload *is* the provider's word, so verification happens first
    // and identity is asked only after it passes — the order the redirect providers get
    // from "state before code".
    const profile = verifyTelegramAuth(input.telegramQuery ?? {}, bot.botToken);
    if (profile === null) {
      throw new ValidationException('the sign-in could not be verified', { provider: 'telegram' });
    }

    return {
      subject: profile.subject,
      email: `${profile.subject}@telegram.invalid`,
      emailVerified: false,
      displayName: profile.displayName,
    };
  },
};
