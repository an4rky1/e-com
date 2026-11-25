/**
 * @fileoverview The gateway's routes, held to `@auth/contracts/http`.
 *
 * @remarks Three maps, three assertions. Auth controllers are checked against `ApiRoutes`;
 * storefront controllers against `StorefrontRoutes`; and the decorators that decide *who*
 * may reach a route — `@Public()` and `@AllowGuest()` — are checked against the contract's
 * `authenticated` flags and against the explicit guest set below. Nothing enforces that they
 * agree at boot, so they are enforced here: a route renamed in a controller, a seventh route
 * added without a contract entry, or one that quietly gains or loses `@Public()` /
 * `@AllowGuest()` fails this test instead of drifting until a browser trips over it.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AdminRoutes, ApiRoutes, StorefrontRoutes } from '@auth/contracts/http';
import { AuthController } from '../src/presentation/auth.controller';
import { UsersController } from '../src/presentation/users.controller';
import { CatalogController } from '../src/presentation/catalog.controller';
import { CartController } from '../src/presentation/cart.controller';
import { CheckoutController } from '../src/presentation/checkout.controller';
import { OrdersController } from '../src/presentation/orders.controller';
import { WebhooksController } from '../src/presentation/webhooks.controller';
import { RoleAdministrationController } from '../src/presentation/role-administration.controller';
import { IS_GUEST_ALLOWED, IS_PUBLIC_ROUTE } from '../src/presentation/decorators/route-metadata';

type ReflectedRoute = {
  readonly path: string;
  readonly method: string;
  readonly authenticated: boolean;
  readonly guestAllowed: boolean;
};

/** Reads the routes Nest sees on a controller: path, verb, and which guards it opens to. */
const routesOf = (
  controller: { prototype: object },
  basePath: string,
): ReflectedRoute[] => {
  const proto = controller.prototype as unknown as Record<string, unknown>;

  return Object.getOwnPropertyNames(controller.prototype).flatMap(
    (name): ReflectedRoute[] => {
      // The constructor is the class object itself, and `hasMetadata` on it finds the
      // controller's own `PATH_METADATA` — which would reflect `auth` as a route called
      // `auth/auth`.
      const handler = name === 'constructor' ? undefined : proto[name];
      if (typeof handler !== 'function' || !Reflect.hasMetadata(PATH_METADATA, handler)) {
        return [];
      }

      const sub = String(Reflect.getMetadata(PATH_METADATA, handler));
      return [
        {
          path: `/${basePath}/${sub}`
            .replace(/\/{2,}/g, '/')
            .replace(/\/$/, ''),
          method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number],
          authenticated: Reflect.getMetadata(IS_PUBLIC_ROUTE, handler) !== true,
          guestAllowed: Reflect.getMetadata(IS_GUEST_ALLOWED, handler) === true,
        },
      ];
    },
  );
};

const AUTH_ROUTES = [
  ...routesOf(AuthController, 'auth'),
  ...routesOf(UsersController, 'users'),
];

const ADMIN_ROUTES = routesOf(RoleAdministrationController, 'access-control');

const STOREFRONT_ROUTES = [
  ...routesOf(CatalogController, 'catalog'),
  ...routesOf(CartController, 'cart'),
  ...routesOf(CheckoutController, 'checkout'),
  ...routesOf(OrdersController, 'orders'),
  ...routesOf(WebhooksController, 'webhooks'),
];

describe('auth controllers vs ApiRoutes', () => {
  it('exposes exactly the contract paths — no more, no fewer', () => {
    const contract = Object.values(ApiRoutes)
      .map((route) => route.path)
      .sort();
    const reflected = AUTH_ROUTES.map((route) => route.path).sort();

    expect(reflected).toEqual(contract);
  });

  it('uses the contract verb on every path', () => {
    for (const route of Object.values(ApiRoutes)) {
      const reflected = AUTH_ROUTES.find((found) => found.path === route.path);
      expect(reflected?.method).toBe(route.method);
    }
  });

  it('opens without a token exactly the routes the contract calls unauthenticated', () => {
    for (const route of Object.values(ApiRoutes)) {
      const reflected = AUTH_ROUTES.find((found) => found.path === route.path);
      expect(reflected?.authenticated).toBe(route.authenticated);
    }
  });
});

describe('storefront controllers vs StorefrontRoutes', () => {
  it('exposes exactly the contract paths — no more, no fewer', () => {
    const contract = Object.values(StorefrontRoutes)
      .map((route) => route.path)
      .sort();
    const reflected = STOREFRONT_ROUTES.map((route) => route.path).sort();

    expect(reflected).toEqual(contract);
  });

  it('uses the contract verb on every path', () => {
    for (const route of Object.values(StorefrontRoutes)) {
      const reflected = STOREFRONT_ROUTES.find((found) => found.path === route.path);
      expect(reflected?.method).toBe(route.method);
    }
  });

  it('opens without a token exactly the routes the contract calls unauthenticated', () => {
    for (const route of Object.values(StorefrontRoutes)) {
      const reflected = STOREFRONT_ROUTES.find((found) => found.path === route.path);
      expect(reflected?.authenticated).toBe(route.authenticated);
    }
  });
});

describe('role administration controller vs AdminRoutes', () => {
  it('exposes exactly the contract paths — no more, no fewer', () => {
    const contract = Object.values(AdminRoutes)
      .map((route) => route.path)
      .sort();
    const reflected = ADMIN_ROUTES.map((route) => route.path).sort();

    expect(reflected).toEqual(contract);
  });

  it('uses the contract verb and authentication flag on every path', () => {
    for (const route of Object.values(AdminRoutes)) {
      const reflected = ADMIN_ROUTES.find((found) => found.path === route.path);
      expect(reflected?.method).toBe(route.method);
      expect(reflected?.authenticated).toBe(route.authenticated);
    }
  });
});

describe('guest-allowed routes', () => {
  it('opens with a guest id exactly the routes the platform hands a guest', () => {
    // The basket and `/auth/me`: an anonymous browser shops, and asks who it is, with the
    // id in `X-Guest-Id`. `/cart/merge` is deliberately absent — folding a guest basket
    // *into* an account stays bearer-only — and this exact list is what keeps it so.
    const guestAllowed = [...AUTH_ROUTES, ...STOREFRONT_ROUTES]
      .filter((route) => route.guestAllowed)
      .map((route) => route.path)
      .sort();

    expect(guestAllowed).toEqual([
      '/auth/me',
      '/cart',
      '/cart/clear',
      '/cart/items',
      '/cart/items/remove',
      '/cart/items/update',
    ]);
  });
});
