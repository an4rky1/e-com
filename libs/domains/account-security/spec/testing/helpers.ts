/**
 * @fileoverview Small test helpers.
 *
 * @remarks These exist because the two things every one of these suites keeps wanting — "give me
 * the reason this promise rejected" and "give me this domain event's payload" — both need a cast
 * the compiler does not offer. Wrapping the cast once means the assertion reads as an assertion
 * instead of as a type error.
 */
import type { IDomainEvent } from '@auth/core';

/** Awaits a promise that is expected to reject, and returns the reason it rejected with. */
export const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
};

/**
 * A domain event's payload.
 *
 * @remarks `IDomainEvent` carries no `payload` field by design — the interface is the transport
 * shape, and a payload is the concrete event's business. Asserting on one therefore needs a
 * widening cast, and doing it here keeps `as unknown as` out of the test bodies.
 */
export const payloadOf = <T = Record<string, unknown>>(event: IDomainEvent): T =>
  (event as unknown as { payload: T }).payload;

/** The first payload whose event type matches, or throws naming what was buffered instead. */
export const payloadFor = <T = Record<string, unknown>>(
  events: readonly IDomainEvent[],
  eventType: string,
): T => {
  const match = events.find((event) => event.eventType === eventType);
  if (!match) {
    throw new Error(
      `no "${eventType}" event; buffered: ${events.map((event) => event.eventType).join(', ')}`,
    );
  }
  return payloadOf<T>(match);
};

/** Fails the test with a useful message rather than asserting on `undefined`. */
export function stored<T>(source: Map<string, T>, key: string): T {
  const found = source.get(key);
  if (!found) throw new Error(`expected ${key} to be present`);
  return found;
}

/** A fixed clock, so "15 minutes later" is arithmetic rather than a `sleep`. */
export const at = (iso: string): Date => new Date(iso);

export const minutes = (count: number): number => count * 60_000;