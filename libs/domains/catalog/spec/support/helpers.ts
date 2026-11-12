/**
 * @fileoverview Two casts the compiler will not do for a test.
 *
 * @remarks `IDomainEvent` deliberately carries no `payload` — it is the transport shape, and a
 * payload is the concrete event's business — so asserting on one needs a widening cast. Doing it
 * here once means the assertion in the test body reads as an assertion instead of as a type
 * error, and means a change to the event shape breaks one file.
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

/** Runs a synchronous call that is expected to throw, and returns what it threw. */
export const thrown = (fn: () => unknown): unknown => {
  try {
    return fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned');
};

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
