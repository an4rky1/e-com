//@ts-check

/**
 * The browser is same-origin with this app, not with the gateway, so every peer call is
 * proxied here rather than addressed directly: a CORS policy on the gateway would be a second
 * configuration surface the front has to know about, and a wrong `GATEWAY_URL` would only
 * show up as a failed preflight. One base URL, `''`, is all a component needs.
 *
 * `GATEWAY_URL` is read when the config module is evaluated, so it must be in the environment
 * before `next dev` starts — setting it afterwards has no effect on a rewrite that already
 * resolved its destination. There is no default on purpose: a wrong port would otherwise fail
 * as an empty login form rather than as a missing variable, and the harness exports one.
 */
const GATEWAY_URL = process.env.GATEWAY_URL;

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    if (!GATEWAY_URL) {
      throw new Error('GATEWAY_URL must be set before the front can proxy to the gateway');
    }

    return [
      // The prefix is what makes the component free to name the call rather than the address:
      // `/api/auth/login` and `/auth/login` are the same route to the browser, and the proxy
      // is the only place that knows where it lands. Every `/auth/*` route is covered, not
      // just login, so `me`, `refresh` and `logout` need no second rule when they arrive.
      // The prefix itself is `API_PROXY_PREFIX` in `@auth/contracts/http` — change it there
      // and here together, or the contract's URLs stop matching these sources.
      {
        source: '/api/auth/:path*',
        destination: `${GATEWAY_URL}/auth/:path*`,
      },
      // The account routes under the same rule: `POST /users` (registration) and
      // `POST /users/:id/password` are part of the same edge surface, and a second base URL
      // in a component would be exactly the knowledge the `/api` prefix exists to remove.
      {
        source: '/api/users/:path*',
        destination: `${GATEWAY_URL}/users/:path*`,
      },
      // Storefront routes under the same prefix: catalog, cart, checkout and orders are
      // gateway paths like the auth ones, and a second base URL in a component would be
      // exactly the knowledge `API_PROXY_PREFIX` exists to remove.
      {
        source: '/api/catalog/:path*',
        destination: `${GATEWAY_URL}/catalog/:path*`,
      },
      {
        source: '/api/cart/:path*',
        destination: `${GATEWAY_URL}/cart/:path*`,
      },
      {
        source: '/api/checkout/:path*',
        destination: `${GATEWAY_URL}/checkout/:path*`,
      },
      {
        source: '/api/orders/:path*',
        destination: `${GATEWAY_URL}/orders/:path*`,
      },
      {
        source: '/api/webhooks/:path*',
        destination: `${GATEWAY_URL}/webhooks/:path*`,
      },
      // The bare `/api/catalog` (no trailing segment) is not matched by `:path*` on every
      // Next version the same way; the explicit sibling keeps GET /catalog reachable.
      {
        source: '/api/catalog',
        destination: `${GATEWAY_URL}/catalog`,
      },
      {
        source: '/api/cart',
        destination: `${GATEWAY_URL}/cart`,
      },
      {
        source: '/api/checkout',
        destination: `${GATEWAY_URL}/checkout`,
      },
      {
        source: '/api/orders',
        destination: `${GATEWAY_URL}/orders`,
      },
    ];
  },
};

module.exports = nextConfig;
