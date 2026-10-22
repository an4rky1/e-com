/**
 * @fileoverview Opt a route out of the second-factor requirement.
 *
 * @remarks Lives here, beside {@link MfaGuard}, rather than in the gateway that mostly uses
 * it: the decorator and the guard are one contract — "a route needs this" and "the request
 * gets refused without it" — and shipping two copies of the pair is how they stop agreeing.
 *
 * @remarks `SetMetadata` comes from `@nestjs/common`, never from `@nestjs/cqrs`, which does
 * not export it and would fail to import.
 */

import { SetMetadata } from '@nestjs/common';

/** Reflector key. Read by `MfaGuard` via `getAllAndOverride`. */
export const SKIP_MFA = 'mfa:skip_mfa';

/**
 * Marks a handler or controller as reachable without a second factor.
 *
 * @remarks Only for endpoints where a second factor genuinely adds nothing — the login
 * challenge itself, recovery flows, health probes. Applied to an ordinary authenticated route
 * it is not a convenience, it is a downgrade of that route's security, which is why it is a
 * visible decorator rather than a default.
 */
export const SkipMfa = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_MFA, true);