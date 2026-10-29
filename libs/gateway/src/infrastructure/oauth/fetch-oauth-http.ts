/**
 * @fileoverview {@link OAuthHttpPort} over `fetch`.
 *
 * @remarks Two rules this adapter exists to enforce: every call carries a deadline (a
 * provider that hangs must not hang the browser's callback), and no failure message may
 * contain the query a code travelled in. Codes are single-use credentials in flight; the
 * URLs here are static endpoints and the code goes in a form body, so an error that names
 * the URL cannot leak one — which is exactly why nothing interpolates a built URL into a
 * message at this layer either.
 */
import { Injectable } from '@nestjs/common';
import { DependencyUnavailableException } from '@auth/platform/error-handling';
import type { OAuthHttpPort } from '../../application/oauth/oauth.port';

const TIMEOUT_MS = 10_000;

/** The user agent every HTTP API expects and some (GitHub's) reject without. */
const USER_AGENT = 'auth-platform/oauth';

@Injectable()
export class FetchOAuthHttp implements OAuthHttpPort {
  async postForm(
    url: string,
    form: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const response = await this.send(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams(form).toString(),
    });
    return readBody(response, url);
  }

  async getJson(url: string, bearer?: string): Promise<unknown> {
    const response = await this.send(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(bearer !== undefined ? { Authorization: `Bearer ${bearer}` } : {}),
      },
    });
    return readBody(response, url);
  }

  /** One place where "the provider did not answer" becomes the platform's 503. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const origin = new URL(url).origin;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new DependencyUnavailableException('the identity provider did not answer', {
        origin,
      });
    }
  }
}

/**
 * A response the caller may parse.
 *
 * @remarks A non-2xx is refused here rather than handed on as a body: every endpoint in this
 * walk answers failures with a status *and* a body, and returning the body would let a
 * provider's error JSON be mistaken for a token by a caller that only pattern-matches fields.
 */
async function readBody(response: Response, url: string): Promise<unknown> {
  const origin = new URL(url).origin;
  if (!response.ok) {
    throw new DependencyUnavailableException('the identity provider refused the request', {
      origin,
      status: response.status,
    });
  }
  try {
    return await response.json();
  } catch {
    throw new DependencyUnavailableException(
      'the identity provider answered with something unreadable',
      { origin },
    );
  }
}
