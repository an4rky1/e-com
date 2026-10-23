/**
 * @fileoverview The system clock, behind the {@link CLOCK} token.
 *
 * @remarks Injecting time rather than reading it is what makes "a code from ninety seconds ago
 * is refused" a unit test instead of a flaky one. Every timestamp this service writes comes
 * from here, so a fixture can pin the whole service to a single instant and drive TOTP codes
 * for a *known* time step — the alternative is a suite that only passes on the second of every
 * thirty.
 */

import { Injectable } from '@nestjs/common';
import type { IClock } from '@auth/core';

@Injectable()
export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }

  timestamp(): number {
    return Date.now();
  }
}

/**
 * A clock frozen at one instant, for fixtures and tests.
 *
 * @remarks Not a mock: it implements the same contract, so production code paths — the
 * aggregate's expiry checks, the lockout arithmetic, the enrollment TTL — all run unchanged
 * against it. {@link advance} exists so a suite can step across a TOTP boundary deliberately
 * instead of sleeping, which is what would otherwise make the window tests take thirty seconds
 * each.
 */
export class FixedClock implements IClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  timestamp(): number {
    return this.current.getTime();
  }

  /** Moves time forward by `ms`. Never backwards: a clock that rewinds would reissue counters. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(at: Date): void {
    this.current = new Date(at.getTime());
  }
}