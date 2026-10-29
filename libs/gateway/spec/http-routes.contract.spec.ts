/**
 * @fileoverview The gateway's routes, held to `@auth/contracts/http`.
 *
 * @remarks The contract file claims six routes with these paths, these methods and this
 * guard arrangement; the controllers are the runtime truth. Nothing enforces that they agree
 * at boot, so they are enforced here: a route renamed in a controller, a seventh route added
 * without a contract entry, or one that quietly gains or loses `@Public()` fails this test
 * instead of drifting until a browser trips over it.
 */
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ApiRoutes } from '@auth/contracts/http';
import { AuthController } from '../src/presentation/auth.controller';
import { UsersController } from '../src/presentation/users.controller';
import { IS_PUBLIC_ROUTE } from '../src/presentation/decorators/route-metadata';

type ReflectedRoute = {
  readonly path: string;
  readonly method: string;
  readonly authenticated: boolean;
};

/** Reads the routes Nest sees on a controller: path, verb, and whether `@Public()` opened it. */
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
        },
      ];
    },
  );
};

const ROUTES = [...routesOf(AuthController, 'auth'), ...routesOf(UsersController, 'users')];

describe('controllers vs @auth/contracts/http', () => {
  it('exposes exactly the contract paths — no more, no fewer', () => {
    const contract = Object.values(ApiRoutes)
      .map((route) => route.path)
      .sort();
    const reflected = ROUTES.map((route) => route.path).sort();

    expect(reflected).toEqual(contract);
  });

  it('uses the contract verb on every path', () => {
    for (const route of Object.values(ApiRoutes)) {
      const reflected = ROUTES.find((found) => found.path === route.path);
      expect(reflected?.method).toBe(route.method);
    }
  });

  it('opens without a token exactly the routes the contract calls unauthenticated', () => {
    for (const route of Object.values(ApiRoutes)) {
      const reflected = ROUTES.find((found) => found.path === route.path);
      expect(reflected?.authenticated).toBe(route.authenticated);
    }
  });
});
