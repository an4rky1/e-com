/**
 * @fileoverview The one way this edge talks to an identity provider over HTTP.
 *
 * @remarks A port, for the same reason the gRPC peers have ports: `libs/gateway` may name
 * *which* provider endpoints exist (that is contract), but the mechanism that reaches them —
 * a URL, a form encode, a timeout, an Accept header — is infrastructure, and a use case that
 * could `fetch` directly would carry it instead. Tests substitute this port and never open a
 * socket.
 */

/** Injected token for {@link OAuthHttpPort}; a symbol so a typo cannot resolve a string. */
export const OAUTH_HTTP = Symbol('OAUTH_HTTP');

export interface OAuthHttpPort {
  /**
   * Form-encoded POST, the shape every token endpoint requires, answered as parsed JSON.
   *
   * @remarks `Accept: application/json` is sent even where the endpoint defaults to a form
   * body (GitHub's does): parsing one representation instead of two is the difference
   * between a provider upgrade being a non-event and being a parse failure mid-sign-in.
   */
  postForm(
    url: string,
    form: Readonly<Record<string, string>>,
  ): Promise<unknown>;

  /** GET with an optional bearer token, answered as parsed JSON. */
  getJson(url: string, bearer?: string): Promise<unknown>;
}
