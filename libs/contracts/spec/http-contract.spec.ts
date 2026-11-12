import {
  API_PROXY_PREFIX,
  AllRoutes,
  ApiRoutes,
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  OAUTH_PROVIDERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  StorefrontRoutes,
  apiErrorMessage,
  isApiErrorResponse,
  isOAuthProvider,
  viaOAuth,
  viaProxy,
} from '../src/http';

describe('http surface', () => {
  it('pins the ten auth routes a client may call', () => {
    expect(Object.keys(ApiRoutes)).toEqual([
      'login',
      'register',
      'refresh',
      'logout',
      'me',
      'oauthProviders',
      'oauthStart',
      'oauthCallback',
      'createUser',
      'setPassword',
    ]);
    expect(ApiRoutes.login).toEqual({
      method: 'POST',
      path: '/auth/login',
      authenticated: false,
    });
    expect(ApiRoutes.register).toEqual({
      method: 'POST',
      path: '/auth/register',
      authenticated: false,
    });
    expect(ApiRoutes.oauthProviders).toEqual({
      method: 'GET',
      path: '/auth/oauth',
      authenticated: false,
    });
    expect(ApiRoutes.oauthStart).toEqual({
      method: 'GET',
      path: '/auth/oauth/:provider',
      authenticated: false,
    });
    expect(ApiRoutes.oauthCallback).toEqual({
      method: 'GET',
      path: '/auth/oauth/:provider/callback',
      authenticated: false,
    });
    expect(ApiRoutes.createUser).toEqual({
      method: 'POST',
      path: '/users',
      authenticated: false,
    });
    expect(ApiRoutes.setPassword).toEqual({
      method: 'POST',
      path: '/users/:id/password',
      authenticated: true,
    });
    expect(ApiRoutes.me).toEqual({ method: 'GET', path: '/auth/me', authenticated: true });
  });

  it('marks exactly the credential-free routes as unauthenticated', () => {
    // The public set is registration, the token exchanges and the OAuth walk — everything a
    // person with no account yet has to reach. Anything else asking to be reachable without
    // a token is a hole, not a convenience.
    const publicRoutes = Object.entries(ApiRoutes)
      .filter(([, route]) => !route.authenticated)
      .map(([name]) => name);
    expect(publicRoutes).toEqual([
      'login',
      'register',
      'refresh',
      'oauthProviders',
      'oauthStart',
      'oauthCallback',
      'createUser',
    ]);
  });

  it('pins the storefront routes', () => {
    expect(Object.keys(StorefrontRoutes)).toEqual([
      'catalogList',
      'catalogProduct',
      'catalogCreateProduct',
      'catalogSetPrice',
      'cartGet',
      'cartAddItem',
      'cartUpdateItem',
      'cartRemoveItem',
      'cartClear',
      'checkoutPreview',
      'checkoutCreate',
      'orderList',
      'orderGet',
      'orderCancel',
      'paymentWebhook',
    ]);
    expect(StorefrontRoutes.catalogList).toEqual({
      method: 'GET',
      path: '/catalog',
      authenticated: false,
    });
    expect(StorefrontRoutes.paymentWebhook).toEqual({
      method: 'POST',
      path: '/webhooks/payment',
      authenticated: false,
    });
    expect(StorefrontRoutes.checkoutCreate).toEqual({
      method: 'POST',
      path: '/checkout',
      authenticated: true,
    });
  });

  it('marks exactly the storefront routes without a session', () => {
    // Browsing the catalog needs no account; the PSP webhook is signed, not sessioned.
    const publicRoutes = Object.entries(StorefrontRoutes)
      .filter(([, route]) => !route.authenticated)
      .map(([name]) => name);
    expect(publicRoutes).toEqual(['catalogList', 'catalogProduct', 'paymentWebhook']);
  });

  it('joins both maps into the client-facing surface without collisions', () => {
    expect(Object.keys(AllRoutes)).toHaveLength(
      Object.keys(ApiRoutes).length + Object.keys(StorefrontRoutes).length,
    );
    for (const name of Object.keys(ApiRoutes)) {
      expect(AllRoutes[name as keyof typeof ApiRoutes]).toBe(
        ApiRoutes[name as keyof typeof ApiRoutes],
      );
    }
  });

  it('reaches every route through the proxy prefix', () => {
    expect(API_PROXY_PREFIX).toBe('/api');
    expect(viaProxy(ApiRoutes.login)).toBe('/api/auth/login');
    expect(viaProxy(ApiRoutes.me)).toBe('/api/auth/me');
    expect(viaProxy(ApiRoutes.setPassword)).toBe('/api/users/:id/password');
  });

  it('fills the provider into the parameterised OAuth paths', () => {
    expect(viaOAuth(ApiRoutes.oauthStart, 'google')).toBe('/api/auth/oauth/google');
    expect(viaOAuth(ApiRoutes.oauthCallback, 'github')).toBe(
      '/api/auth/oauth/github/callback',
    );
    // The literal template must never reach a browser.
    expect(viaOAuth(ApiRoutes.oauthCallback, 'google')).not.toContain(':provider');
  });

  it('knows exactly which providers exist', () => {
    expect(OAUTH_PROVIDERS).toEqual(['google', 'github', 'telegram']);
    expect(isOAuthProvider('google')).toBe(true);
    expect(isOAuthProvider('github')).toBe(true);
    expect(isOAuthProvider('telegram')).toBe(true);
    expect(isOAuthProvider('twitter')).toBe(false);
    expect(isOAuthProvider(undefined)).toBe(false);
  });
});

describe('http field limits', () => {
  it('pins the numbers both gates check against', () => {
    // Editing one of these without editing the gateway's decorators would turn this line
    // red — which is the point of having them in one file.
    expect(EMAIL_MAX_LENGTH).toBe(254);
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(512);
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(200);
  });
});

describe('error shape', () => {
  it('recognises the refusal bodies both producers emit', () => {
    expect(isApiErrorResponse({ statusCode: 409, error: 'Conflict' })).toBe(true);
    expect(
      isApiErrorResponse({
        statusCode: 400,
        message: ['email must be a valid address'],
        error: 'Bad Request',
      }),
    ).toBe(true);
    expect(isApiErrorResponse({ error: 'The gateway did not answer' })).toBe(true);
    // The gateway's error filter answers RFC 7807 — `detail` carries the sentence and there
    // is no `error` field at all, which is what the edge actually sends on every refusal.
    expect(
      isApiErrorResponse({
        type: 'https://errors.auth.dev/resource_already_exists',
        title: 'RESOURCE_ALREADY_EXISTS',
        status: 409,
        detail: 'the resource already exists',
        instance: '/auth/register',
      }),
    ).toBe(true);
  });

  it('does not mistake a success body for a refusal', () => {
    expect(isApiErrorResponse({ id: 'u-1', email: 'ada@example.test' })).toBe(false);
    expect(isApiErrorResponse({ accessToken: 'a', refreshToken: 'b' })).toBe(false);
    expect(isApiErrorResponse(null)).toBe(false);
    expect(isApiErrorResponse('<html>502</html>')).toBe(false);
  });

  it('shows the detail the contract carries, or the caller fallback', () => {
    expect(apiErrorMessage({ error: 'email already registered' }, 'Sign-in failed')).toBe(
      'email already registered',
    );
    expect(apiErrorMessage({ accessToken: 'a' }, 'Sign-in failed')).toBe('Sign-in failed');
    expect(apiErrorMessage(undefined, 'Sign-in failed')).toBe('Sign-in failed');
  });

  it('prefers the specific message over the HTTP reason phrase', () => {
    // What class-validator actually produces: the array of field complaints is the answer
    // worth showing, and 'Bad Request' is not an answer at all.
    expect(
      apiErrorMessage(
        { statusCode: 400, message: ['email must be a valid address'], error: 'Bad Request' },
        'fallback',
      ),
    ).toBe('email must be a valid address');
    expect(
      apiErrorMessage({ statusCode: 409, message: 'email already registered', error: 'Conflict' }, 'fallback'),
    ).toBe('email already registered');
    // A single string message with trailing emptiness still falls through to `error`.
    expect(apiErrorMessage({ statusCode: 500, message: '', error: 'Internal Server Error' }, 'fallback')).toBe(
      'Internal Server Error',
    );
  });

  it('joins a message array into one line', () => {
    expect(
      apiErrorMessage(
        { statusCode: 400, message: ['email must be a valid address', 'displayName is too long'], error: 'Bad Request' },
        'fallback',
      ),
    ).toBe('email must be a valid address displayName is too long');
  });

  it('shows the gateway RFC 7807 detail, below any field complaint', () => {
    // The filter the gateway runs never sets `error`; without reading `detail` every screen
    // would show its own fallback instead of the refusal that actually happened.
    expect(
      apiErrorMessage(
        {
          type: 'https://errors.auth.dev/resource_already_exists',
          title: 'RESOURCE_ALREADY_EXISTS',
          status: 409,
          detail: 'the resource already exists',
        },
        'The gateway refused the request',
      ),
    ).toBe('the resource already exists');
    expect(
      apiErrorMessage({ message: ['email must be a valid address'], detail: 'Bad Request' }, 'fallback'),
    ).toBe('email must be a valid address');
    expect(apiErrorMessage({ detail: '', statusCode: 500 }, 'fallback')).toBe('fallback');
  });
});
