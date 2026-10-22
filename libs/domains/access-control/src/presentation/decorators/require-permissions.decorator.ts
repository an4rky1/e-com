import { SetMetadata } from '@nestjs/common';

/** Metadata key read by {@link AccessControlGuard}. */
export const REQUIRED_PERMISSIONS = 'access-control:required-permissions';

export interface PermissionRequirement {
  readonly mode: 'all' | 'any';
  readonly permissions: readonly string[];
}

/**
 * Declares the permissions a route requires — every one of them.
 *
 * @remarks Metadata rather than an argument: the requirement is a fact about the route, so it
 * belongs next to the route handler where a reviewer reads it, not in a call that has to be
 * kept in step with the mapping.
 *
 * @remarks `all` is the default because "may do A **and** B" is what administrative routes
 * actually mean, and a decorator that granted access when one of several requirements was
 * met is a decorator somebody will eventually apply to the wrong route.
 *
 * @remarks The api-gateway reuses these decorators and the guard verbatim. That is why the
 * metadata is a plain, module-free structure — it is a contract between whoever writes a
 * route and whoever enforces it, and both live in this module.
 *
 * @example
 * ```ts
 * @RequirePermissions('users:write')
 * @Post('users/:id/suspend')
 * suspend() {}
 * ```
 */
export const RequirePermissions = (...permissions: string[]): MethodDecorator &
  ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, {
    mode: 'all',
    permissions,
  } satisfies PermissionRequirement);

/** Declares alternatives: holding any one of them is enough. */
export const RequireAnyPermission = (...permissions: string[]): MethodDecorator &
  ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, {
    mode: 'any',
    permissions,
  } satisfies PermissionRequirement);

/**
 * Marks a route as reachable without a permission check.
 *
 * @remarks For routes that authenticate but do not authorise — a profile page, a health
 * probe. Deliberately explicit: a route carrying no metadata at all is denied by the guard,
 * so forgetting a decorator fails closed.
 */
export const PublicEndpoint = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, {
    mode: 'any',
    permissions: [],
  } satisfies PermissionRequirement);