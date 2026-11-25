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
   * route without the marker is an authenticated one. `false` does not mean *anonymous* —
   * the cart routes are `false` and still demand an identity, just a guest id rather than
   * a session; it means no bearer is required to reach the handler.
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
 * The header an anonymous browser carries its guest id in.
 *
 * @remarks Chosen to sit beside `Authorization` rather than inside a body: identity that
 * travels as transport metadata cannot be forged by a page that only controls its payload,
 * and a cross-origin page cannot set it at all without a CORS grant. Both sides read this
 * one constant, so a rename cannot leave the front sending a header the guard ignores.
 */
export const GUEST_ID_HEADER = 'x-guest-id';

/**
 * The auth surface. Twelve routes; anything a client can call for auth is in here.
 *
 * @remarks Auth only. The storefront surface lives in {@link StorefrontRoutes} and is
 * pinned by its own map: the gateway's contract spec compares its auth controllers against
 * *this* object, so a catalog path landing here would read as a missing gateway route.
 */
export const ApiRoutes = {
  login: { method: 'POST', path: '/auth/login', authenticated: false },
  register: { method: 'POST', path: '/auth/register', authenticated: false },
  // The placeholder account an anonymous browser carries between visits. Public for the same
  // reason register is: the callers who need it have no token yet, and the id it accepts is
  // checked by identity rather than guarded here — presenting one buys a renewed guest, never
  // somebody else's account.
  acquireGuest: { method: 'POST', path: '/auth/guest', authenticated: false },
  refresh: { method: 'POST', path: '/auth/refresh', authenticated: false },
  logout: { method: 'POST', path: '/auth/logout', authenticated: true },
  // No bearer is required — the guest id in `X-Guest-Id` answers the same question — but
  // *something* has to: a request with neither is refused before a handler sees it, exactly
  // like the cart routes below.
  me: { method: 'GET', path: '/auth/me', authenticated: false },
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
  getUser: { method: 'GET', path: '/users/:id', authenticated: true },
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
  //
  // `authenticated: false` for the basket itself: an anonymous browser reaches these with
  // a guest id in the `X-Guest-Id` header instead of a bearer — the route needs *an*
  // identity, not a session. `cartMerge` stays `true`: folding a guest basket into an
  // account is something only a signed-in caller can ask for.
  cartGet: { method: 'GET', path: '/cart', authenticated: false },
  cartAddItem: { method: 'POST', path: '/cart/items', authenticated: false },
  cartUpdateItem: { method: 'POST', path: '/cart/items/update', authenticated: false },
  cartRemoveItem: { method: 'POST', path: '/cart/items/remove', authenticated: false },
  cartClear: { method: 'POST', path: '/cart/clear', authenticated: false },
  cartMerge: { method: 'POST', path: '/cart/merge', authenticated: true },

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
 * The administrative surface: the role catalogue and the grant/revoke pair.
 *
 * @remarks A third map because these routes are neither auth nor shopping. All are
 * bearer-only — each declares the permission it needs — and the gateway controller behind
 * them forwards to access-control over gRPC. Revoke is a POST rather than a DELETE because
 * the contract's verb set is GET|POST; the body names the role.
 */
export const AdminRoutes = {
  rolesList: { method: 'GET', path: '/access-control/roles', authenticated: true },
  roleGrant: {
    method: 'POST',
    path: '/access-control/users/:userId/roles',
    authenticated: true,
  },
  roleRevoke: {
    method: 'POST',
    path: '/access-control/users/:userId/roles/revoke',
    authenticated: true,
  },
} as const satisfies Record<string, ApiRoute>;

/**
 * Everything a client may call, all maps in one object.
 *
 * @remarks The front's view: a page never cares which process answers a path, only what to
 * send. The split survives in the maps above, where it belongs to the gateway's specs.
 */
export const AllRoutes = {
  ...ApiRoutes,
  ...StorefrontRoutes,
  ...AdminRoutes,
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
