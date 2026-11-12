/**
 * @fileoverview Small helpers shared by the order suites.
 */
import { SagaExecutionError, type IDomainEvent } from '@auth/core';

/** Throws `fn` and returns the error, so a test can assert on the type without try/catch noise. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Async variant of {@link thrown}. */
export async function thrownAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * The business error inside a saga failure.
 *
 * @remarks `SagaOrchestrator` wraps the failing step's error so the caller also learns
 * which compensations failed. Assertions about *what went wrong* care about the cause.
 */
export function causeOf(error: unknown): unknown {
  return error instanceof SagaExecutionError ? error.cause : error;
}

/** Async {@link thrownAsync} that unwraps `SagaExecutionError.cause`. */
export async function thrownCause(fn: () => Promise<unknown>): Promise<unknown> {
  return causeOf(await thrownAsync(fn));
}

/** Payloads of events whose `eventType` matches, in order. */
export function payloadsFor(
  events: readonly IDomainEvent[],
  eventType: string,
): Record<string, unknown>[] {
  return events
    .filter((event) => event.eventType === eventType)
    .map((event) => (event as unknown as { payload: Record<string, unknown> }).payload);
}

/** The single payload of `eventType`, or `undefined`. */
export function payloadFor(
  events: readonly IDomainEvent[],
  eventType: string,
): Record<string, unknown> | undefined {
  return payloadsFor(events, eventType)[0];
}
