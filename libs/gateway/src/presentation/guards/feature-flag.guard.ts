/**
 * @fileoverview Hides a route whose feature flag is off — as a 404, not a 403.
 *
 * @remarks A 403 confirms the endpoint exists and only lacks permission, which advertises
 * unshipped surface to exactly the callers who will probe it. 404 keeps the map of the API
 * equal to what is actually shipped: the route is not in the world until its flag is on.
 *
 * @remarks Runs before authentication when stacked first, same reasoning as the rate-limit
 * guard: a feature that is off should cost the caller nothing and the service nothing,
 * whether or not the caller is (or claims to be) anyone.
 */
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
// Value import on purpose — see the note in `jwt-auth.guard.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import { FEATURE_FLAGS, type FeatureFlagsService } from '@auth/platform/feature-flags';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import { FEATURE_FLAG } from '../decorators/feature-flag';

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(FEATURE_FLAGS) private readonly flags: FeatureFlagsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const flags = this.reflector.getAllAndOverride<string[] | undefined>(FEATURE_FLAG, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!flags || flags.length === 0) return true;

    if (flags.every((flag) => this.flags.isEnabled(flag))) return true;

    throw new ResourceNotFoundException('route not found');
  }
}
