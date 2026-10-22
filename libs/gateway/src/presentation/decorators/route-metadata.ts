/**
 * @fileoverview Route metadata the gateway's own guards read.
 *
 * @remarks `Reflector` keys are `Symbol`s for the same reason DI tokens are: two libraries
 * that both decided to use `'isPublic'` as a string would silently share an answer, and the
 * symptom is a login endpoint that is reachable by accident rather than by decision.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

/**
 * Marks a route reachable without an access token.
 *
 * @remarks Required, not a convenience: the guard denies by default, so `POST /auth/login`
 * is unreachable without this. A guard that admits unless told otherwise means the route
 * somebody forgot is the one that leaks.
 */
export const IS_PUBLIC_ROUTE = Symbol('IS_PUBLIC_ROUTE');

export const Public = (): CustomDecorator<symbol> =>
  SetMetadata(IS_PUBLIC_ROUTE, true);

/** Permissions a route demands. Read by `PermissionsGuard`, answered by access-control. */
export const REQUIRED_PERMISSIONS = Symbol('REQUIRED_PERMISSIONS');

/**
 * Declares what a route needs.
 *
 * @remarks The list is a requirement on the *caller*, not on the resource: `PermissionsGuard`
 * asks access-control once per permission and forwards the answer. Nothing here says which
 * role grants it, because that is access-control's data and duplicating it here is how the
 * two drift.
 */
export const RequirePermissions = (
  ...permissions: readonly string[]
): CustomDecorator<symbol> => SetMetadata(REQUIRED_PERMISSIONS, permissions);
