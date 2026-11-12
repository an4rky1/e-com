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

/**
 * The public surface. Ten routes; anything a client can call is in here.
 *
 * @remarks Auth only. The storefront surface lives in {@link StorefrontRoutes} and is
 * pinned by its own map: the gateway's contract spec compares its auth controllers against
 * *this* object, so a catalog path landing here would read as a missing gateway route.
 */
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

/**
 * The storefront surface: catalog, cart, checkout, orders, and the PSP webhook.
 *
 * @remarks A separate map rather than more keys on {@link ApiRoutes}, because the two maps
 * answer different questions with different owners. `ApiRoutes` is what the auth gateway
 * serves *today*, and its contract spec holds the controllers to exactly that set — merging
 * storefront paths into it would make every gateway spec red for routes no controller has
 * yet. When the gateway gains the storefront controllers, this map becomes the second half
 * of its contract, and the front reads both through {@link AllRoutes}.
 */
export const StorefrontRoutes = {
  // Catalog reads are public: the vitrina is reachable before sign-in.
  catalogList: { method: 'GET', path: '/catalog', authenticated: false },
  catalogProduct: { method: 'GET', path: '/catalog/:id', authenticated: false },
  catalogCreateProduct: {
    method: 'POST',
    path: '/catalog/admin/products',
    authenticated: true,
  },
  catalogSetPrice: {
    method: 'POST',
    path: '/catalog/admin/price',
    authenticated: true,
  },

  // Cart mutations are POST rather than PATCH/DELETE: the contract's verb set is GET|POST,
  // and a body-carrying POST keeps the front's single `fetch` helper honest.
  cartGet: { method: 'GET', path: '/cart', authenticated: true },
  cartAddItem: { method: 'POST', path: '/cart/items', authenticated: true },
  cartUpdateItem: { method: 'POST', path: '/cart/items/update', authenticated: true },
  cartRemoveItem: { method: 'POST', path: '/cart/items/remove', authenticated: true },
  cartClear: { method: 'POST', path: '/cart/clear', authenticated: true },

  // Checkout is the order facade: it reads the cart, creates the order, and lets the
  // order service drive reserve → charge → confirm through its saga.
  checkoutPreview: { method: 'POST', path: '/checkout/preview', authenticated: true },
  checkoutCreate: { method: 'POST', path: '/checkout', authenticated: true },

  orderList: { method: 'GET', path: '/orders', authenticated: true },
  orderGet: { method: 'GET', path: '/orders/:id', authenticated: true },
  orderCancel: { method: 'POST', path: '/orders/:id/cancel', authenticated: true },

  // The only unauthenticated write surface outside auth itself: the PSP calls it with a
  // signed body, and the signature — not a session — is what proves authenticity.
  paymentWebhook: { method: 'POST', path: '/webhooks/payment', authenticated: false },
} as const satisfies Record<string, ApiRoute>;

/**
 * Everything a client may call, both maps in one object.
 *
 * @remarks The front's view: a page never cares which process answers a path, only what to
 * send. The split survives in the two maps above, where it belongs to the gateway's specs.
 */
export const AllRoutes = { ...ApiRoutes, ...StorefrontRoutes } as const satisfies Record<
  string,
  ApiRoute
>;

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
