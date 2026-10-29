/**
 * @fileoverview Opts a route into request idempotency.
 *
 * @remarks A decorator rather than a route list because the decision belongs next to the
 * handler it protects: whether a response may be replayed is a property of what the handler
 * returns, and a table elsewhere would separate the two just far enough that they drift.
 *
 * @remarks The mode is the only choice, and the safe default is `dedup` — it records that
 * the request ran without storing the response body, so a route that returns tokens can be
 * protected while those tokens never reach Redis. `replay` caches the body and answers
 * retries with it, which is only for routes whose response is a plain value; saying so at
 * the handler is what keeps that choice reviewable.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { IdempotencyOptions } from '@auth/infra/idempotency';

export const IDEMPOTENT = Symbol('IDEMPOTENT');

export const Idempotent = (
  options: IdempotencyOptions = {},
): CustomDecorator<symbol> => SetMetadata(IDEMPOTENT, options);
