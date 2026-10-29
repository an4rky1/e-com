'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiRoutes, viaOAuth, viaProxy } from '@auth/contracts/http';
import type { OAuthProvidersResponse } from '@auth/contracts/http';
import styles from './page.module.scss';

/**
 * The provider buttons, on whichever page offers a way in.
 *
 * @remarks The list is *read* before anything is drawn: a provider with no client pair at
 * the gateway is an absent button rather than a link that ends in a 503, so an unconfigured
 * deployment still has a working password form instead of a broken row. The navigation
 * itself is a plain link to the gateway's start route — the walk is a browser redirect, and
 * anything fancier would put a hop between the click and the provider.
 *
 * @remarks Telegram is not a link but a widget: Telegram's own script renders the button,
 * and the button posts the browser straight to the callback with a signed payload — there
 * is no start route to link to. The script is therefore *attached* once the provider list
 * arrives (and detached when it leaves), carrying the bot username the gateway reported and
 * an absolute callback URL, because Telegram will not accept a relative one.
 *
 * @remarks Nothing is rendered until the answer arrives, and a failed read renders nothing
 * at all: the provider row is an enhancement over the form above it, and a page that cannot
 * ask must not refuse to sign anybody in.
 */
export default function OAuthButtons() {
  const [available, setAvailable] = useState<OAuthProvidersResponse | null>(null);
  const telegramHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const ask = async () => {
      try {
        const response = await fetch(viaProxy(ApiRoutes.oauthProviders));
        if (!response.ok) return;
        const payload = (await response.json()) as OAuthProvidersResponse;
        if (!cancelled) setAvailable(payload);
      } catch {
        // No answer, no buttons: the form above still works.
      }
    };
    void ask();

    return () => {
      cancelled = true;
    };
  }, []);

  const telegramBot =
    available?.telegram === true ? available.telegramBotUsername : null;

  useEffect(() => {
    const host = telegramHost.current;
    if (host === null || telegramBot === null) return;

    host.replaceChildren();
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', telegramBot);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute(
      'data-auth-url',
      `${window.location.origin}${viaOAuth(ApiRoutes.oauthCallback, 'telegram')}`,
    );
    host.appendChild(script);

    return () => host.replaceChildren();
  }, [telegramBot]);

  if (available === null || (!available.google && !available.github && telegramBot === null)) {
    return null;
  }

  return (
    <section className={styles.providers} aria-label="or continue with">
      <p className={styles.muted}>or continue with</p>
      <div className={styles.row}>
        {available.google ? (
          <a
            className={styles.provider}
            href={viaOAuth(ApiRoutes.oauthStart, 'google')}
            data-testid="oauth-google"
          >
            Google
          </a>
        ) : null}
        {available.github ? (
          <a
            className={styles.provider}
            href={viaOAuth(ApiRoutes.oauthStart, 'github')}
            data-testid="oauth-github"
          >
            GitHub
          </a>
        ) : null}
        {telegramBot !== null ? (
          <div className={styles.telegram} data-testid="oauth-telegram" ref={telegramHost} />
        ) : null}
      </div>
    </section>
  );
}
