/**
 * @fileoverview `FeatureFlagGuard`: a flag that is off erases the route, as a 404.
 *
 * @remarks Every decision worth pinning: an undecorated route passes untouched, AND
 * semantics when several flags share a route, the 403-never-404 choice, and — the one that
 * protects a rollout — a flag whose name is misspelled in the decorator stays off rather
 * than accidentally shipping.
 */
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagsService } from '@auth/platform/feature-flags';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import { FeatureFlag } from '../src/presentation/decorators/feature-flag';
import { FeatureFlagGuard } from '../src/presentation/guards/feature-flag.guard';

class TestRoutes {
  @FeatureFlag('new-login')
  gated(): string {
    return 'gated';
  }

  @FeatureFlag('new-login', 'new-billing')
  multiGate(): string {
    return 'multiGate';
  }

  plain(): string {
    return 'plain';
  }
}

const contextFor = (handler: keyof TestRoutes = 'plain'): ExecutionContext =>
  ({
    getHandler: () => TestRoutes.prototype[handler],
    getClass: () => TestRoutes,
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }),
  }) as unknown as ExecutionContext;

const guardFor = (active: string[]): FeatureFlagGuard =>
  new FeatureFlagGuard(new Reflector(), new FeatureFlagsService({ active }));

describe('FeatureFlagGuard', () => {
  it('passes a route with no flag metadata untouched', () => {
    expect(guardFor([]).canActivate(contextFor('plain'))).toBe(true);
  });

  it('allows a decorated route while its flag is on', () => {
    expect(guardFor(['new-login']).canActivate(contextFor('gated'))).toBe(true);
  });

  it('answers 404 — not 403 — while the flag is off', () => {
    let caught: unknown;
    try {
      guardFor([]).canActivate(contextFor('gated'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ResourceNotFoundException);
    expect((caught as ResourceNotFoundException).getStatus()).toBe(404);
  });

  it('requires every flag of a multi-flag route, not any one of them', () => {
    expect(guardFor(['new-login', 'new-billing']).canActivate(contextFor('multiGate'))).toBe(
      true,
    );
    expect(() => guardFor(['new-login']).canActivate(contextFor('multiGate'))).toThrow(
      ResourceNotFoundException,
    );
  });

  it('keeps a flag whose name is wrong in the decorator off, not on', () => {
    // The rollout half of the contract: an unknown flag resolves false, so a typo hides the
    // route instead of shipping it.
    expect(() => guardFor(['new-logn']).canActivate(contextFor('gated'))).toThrow(
      ResourceNotFoundException,
    );
  });
});
