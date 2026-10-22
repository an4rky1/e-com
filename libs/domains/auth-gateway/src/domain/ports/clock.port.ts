/**
 * @fileoverview Where the gateway gets the time.
 *
 * @remarks An interface for one method, because it is the seam that makes expiry testable: a
 * suite that can hand the handlers a clock 10 minutes past a flow's TTL proves the rule, while
 * a suite that reaches for `new Date()` can only wait for it. It also comes from the kernel —
 * the gateway did not need a second clock abstraction, so it did not invent one.
 */
import type { IClock } from '@auth/ddd-core';

export const CLOCK = Symbol('CLOCK');

export type { IClock };