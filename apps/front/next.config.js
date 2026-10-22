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
      {
        source: '/api/auth/:path*',
        destination: `${GATEWAY_URL}/auth/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
