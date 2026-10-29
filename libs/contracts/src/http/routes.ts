/**
 * @fileoverview The gateway's HTTP surface, as both sides know it.
 *
 * @remarks Routes are contract, not decoration: the gateway's controllers are checked
 * against this file (see `spec/http-routes.contract.spec.ts` in the gateway), and the front
 * builds every request from it — path, method and whether a token is required. A route that
 * moves or changes its guard has to change here first, and the mismatch shows up as a failing
 * test rather than as a 404 a tester discovers by hand.
 */

/** The HTTP verbs this surface uses. */
export type ApiMethod = 'GET' | 'POST';

export interface ApiRoute {
  readonly method: ApiMethod;
  /** Gateway-relative path, in the gateway's own spelling (`:id` for a path parameter). */
  readonly path: string;
  /**
   * Whether the route needs a Bearer token to be reachable at all.
   *
   * @remarks The inverse of the gateway's `@Public()`: the guard denies by default, so a
   * route without the marker is an authenticated one.
   */
  readonly authenticated: boolean;
}

/**
 * How the browser reaches the gateway: every gateway path is served under this prefix.
 *
 * @remarks The front's rewrites copy `/api/<gateway path>` through to `${GATEWAY_URL}/<path>`,
 * so this string is the seam between the two — it names where a page's fetch is answered by
 * the front and where the gateway takes over.
 */
export const API_PROXY_PREFIX = '/api';

/** The public surface. Ten routes; anything a client can call is in here. */
export const ApiRoutes = {
  login: { method: 'POST', path: '/auth/login', authenticated: false },
  register: { method: 'POST', path: '/auth/register', authenticated: false },
  refresh: { method: 'POST', path: '/auth/refresh', authenticated: false },
  logout: { method: 'POST', path: '/auth/logout', authenticated: true },
  me: { method: 'GET', path: '/auth/me', authenticated: true },
  // `/auth/oauth` is declared before the parameterised route on purpose: Nest resolves in
  // registration order, so the literal path has to be claimed before `:provider` could
  // swallow it as a provider named "oauth".
  oauthProviders: { method: 'GET', path: '/auth/oauth', authenticated: false },
  oauthStart: { method: 'GET', path: '/auth/oauth/:provider', authenticated: false },
  oauthCallback: {
    method: 'GET',
    path: '/auth/oauth/:provider/callback',
    authenticated: false,
  },
  createUser: { method: 'POST', path: '/users', authenticated: false },
  setPassword: { method: 'POST', path: '/users/:id/password', authenticated: true },
} as const satisfies Record<string, ApiRoute>;

/** The browser-side URL for a route: the gateway path behind the front's proxy prefix. */
export const viaProxy = (route: ApiRoute): string => `${API_PROXY_PREFIX}${route.path}`;

/**
 * The same, for a route whose path names an OAuth provider.
 *
 * @remarks A parameterised route is a template until a provider fills it — the browser must
 * see `/api/auth/oauth/google/callback`, never the literal `:provider` the contract spells.
 */
export const viaOAuth = (route: ApiRoute, provider: string): string =>
  viaProxy(route).replace(':provider', provider);
