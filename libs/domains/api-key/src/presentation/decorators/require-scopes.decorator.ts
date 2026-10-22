/**
 * @fileoverview Declares the scopes a route requires.
 *
 * @remarks Lives beside {@link ApiKeyAuthGuard} rather than in api-gateway, which is where most
 * of its uses will be: the decorator and the guard are one contract — "a route needs this" and
 * "the request is refused without it" — and shipping two copies of the pair is how they stop
 * agreeing about what a machine credential may do.
 *
 * @remarks `SetMetadata` comes from `@nestjs/common`, never from `@nestjs/cqrs`, which does not
 * export it and would fail to import.
 */
import { SetMetadata } from '@nestjs/common';
import type { ApiKeyScope } from '../../domain/value-objects/api-key-scope.vo';

/** Reflector key. Read by `ApiKeyAuthGuard` via `getAllAndOverride`. */
export const REQUIRED_SCOPES = 'api-key:required_scopes';

/**
 * Marks a handler or controller as requiring these scopes.
 *
 * @remarks Every listed scope must be held — `satisfiesScopes` treats the argument as a
 * conjunction, because "may delete *and* may read" is what an administrative route actually
 * means. A route with no decorator is authenticated but unscoped, which is the right default:
 * a machine key that has proved possession gets to call routes that never asked about authority.
 *
 * @remarks The single place in the platform where holding more access satisfies a requirement it
 * does not literally carry: `@RequireScopes(ApiKeyScope.ADMIN)` is satisfied by any `admin` key,
 * which is what `SUPER_SCOPE` means.
 */
export const RequireScopes = (
  ...scopes: readonly ApiKeyScope[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_SCOPES, [...scopes]);