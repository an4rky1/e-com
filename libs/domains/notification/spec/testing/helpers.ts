/**
 * Small test helpers.
 *
 * @remarks These exist because the two things every suite here keeps wanting — "give me the
 * reason this promise rejected" and "give me this event's payload" — both need a cast the
 * compiler does not offer. Wrapping the cast once means the assertion reads as an assertion
 * instead of as a type error.
 */

/** Awaits a promise that is expected to reject, and returns the reason it rejected with. */
export const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
};

/** A domain event's own payload. */
export const payloadOf = <T = Record<string, unknown>>(event: unknown): T =>
  (event as { payload: T }).payload;

/** Fails with a useful message rather than asserting on `undefined`. */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}