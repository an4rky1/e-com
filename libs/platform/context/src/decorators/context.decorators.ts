/**
 * @fileoverview Reads the ids the middleware stamped on the request.
 *
 * @remarks Parameter decorators cannot inject, so they read the request object — the same
 * place `@CurrentPrincipal` reads its guard's output. The stamping happens once, in
 * `runWithRequest`, so request and context can never disagree about the id.
 */
import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { ContextRequestLike } from '../context.types';

/** This request's correlation id, as echoed in the response headers. */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<ContextRequestLike>().correlationId,
);

/** This request's server-minted request id. */
export const RequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<ContextRequestLike>().requestId,
);
