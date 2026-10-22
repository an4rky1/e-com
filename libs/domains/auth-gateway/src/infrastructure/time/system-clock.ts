/**
 * @fileoverview The system clock.
 *
 * @remarks Deliberately thin: an adapter exists so that the *port* has an implementation, not
 * so that this class can be interesting. Everything time-shaped in the domain takes a `Date`
 * argument, so the clock only decides where that argument comes from — and in a suite, from
 * {@link FixedClock} instead.
 */
import { Injectable } from '@nestjs/common';
import type { IClock } from '@auth/ddd-core';

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
 * A clock that only moves when told to.
 *
 * @remarks Exported because it is a test double that happens to have no dependencies: a suite
 * that proves "a flow expires after five minutes" by waiting five minutes has proved nothing
 * that a five-second test does not.
 */
export class FixedClock implements IClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  timestamp(): number {
    return this.current.getTime();
  }

  /** Moves time forward, without going backwards. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(at: Date): void {
    this.current = new Date(at);
  }
}