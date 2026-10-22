import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { throwError, type Observable } from 'rxjs';
import { AppException, redact } from '../app.exception';
import { ERROR_DEFINITIONS } from '../error-codes';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  traceId?: string;
  timestamp: string;
  errors?: unknown;
}

/**
 * gRPC status codes, keyed by the HTTP status this platform maps them to.
 *
 * @remarks A handler that throws under gRPC gets its error serialized by this filter. If the
 * filter assumed an HTTP request it would throw *while handling the original error*, and the
 * caller would see a TypeError from the error path instead of the failure that actually
 * happened — which is how a wrong password turns into "unavailable" with nothing in the log.
 */
const GRPC_STATUS_BY_HTTP: Readonly<Record<number, number>> = {
  [HttpStatus.BAD_REQUEST]: 3, // INVALID_ARGUMENT
  [HttpStatus.UNAUTHORIZED]: 16, // UNAUTHENTICATED
  [HttpStatus.FORBIDDEN]: 7, // PERMISSION_DENIED
  [HttpStatus.NOT_FOUND]: 5, // NOT_FOUND
  [HttpStatus.CONFLICT]: 6, // ALREADY_EXISTS
  [HttpStatus.GONE]: 9, // FAILED_PRECONDITION
  [HttpStatus.TOO_MANY_REQUESTS]: 8, // RESOURCE_EXHAUSTED
  [HttpStatus.NOT_IMPLEMENTED]: 12,
  [HttpStatus.SERVICE_UNAVAILABLE]: 14, // UNAVAILABLE
  [HttpStatus.GATEWAY_TIMEOUT]: 4, // DEADLINE_EXCEEDED
};

/**
 * Catch-all for both transports.
 *
 * @remarks Unknown errors are reported as a flat 500 with no detail. An unhandled error's
 * message can carry a connection string or a stack path, and the difference between a useful
 * error and a data breach is usually only what the author assumed the reader could see. The
 * full error still reaches the log with its trace id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): Observable<never> | void {
    // `getType()` is the only reliable discriminator: under gRPC, `switchToHttp()` hands
    // back a context object whose `headers` is undefined, so probing for one and hoping is
    // how the two transports end up sharing a filter that only works for HTTP.
    if (host.getType<string>() !== 'http') {
      return this.handleRpc(exception);
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const problem = this.toProblemDetails(exception, request);

    this.log(problem.status, request.method, problem.instance, problem.code, exception);

    response
      .status(problem.status)
      .type('application/problem+json')
      .json(problem);
  }

  private handleRpc(exception: unknown): Observable<never> {
    const status = httpStatusOf(exception);
    const code = codeOf(exception);

    this.logger.error(
      `gRPC ${code} -> ${status}: ${messageOf(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // Returned, never thrown. A filter's return value is the stream the gRPC server hands to
    // `call.emit('error', ...)`; throwing out of `catch` instead tears the whole call down
    // without a status, and the caller then sees UNAVAILABLE / "Connection dropped" for what
    // was really a 409 or a 404. That inversion is invisible from the server side — the log
    // shows the right code, and only the caller's status is wrong.
    return throwError(() => ({
      code: GRPC_STATUS_BY_HTTP[status] ?? 2,
      details: code,
      message: messageOf(exception),
    }));
  }

  private toProblemDetails(
    exception: unknown,
    request: Request,
  ): ProblemDetails {
    const traceId = (request.headers?.['x-trace-id'] as string | undefined) ?? undefined;
    const path = request.originalUrl ?? request.url ?? '';

    if (exception instanceof AppException) {
      return {
        type: `https://errors.auth.dev/${exception.code.toLowerCase()}`,
        title: exception.code,
        status: exception.getStatus(),
        detail: exception.message,
        instance: path,
        code: exception.code,
        traceId,
        timestamp: exception.timestamp.toISOString(),
        errors: Object.keys(exception.context).length
          ? redact(exception.context)
          : undefined,
      };
    }

    if (exception instanceof HttpException) {
      return {
        type: 'https://errors.auth.dev/http_error',
        title: 'HTTP_ERROR',
        status: exception.getStatus(),
        detail: exception.message,
        instance: path,
        code: 'HTTP_ERROR',
        traceId,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      type: `https://errors.auth.dev/${ERROR_DEFINITIONS.INTERNAL_ERROR.code.toLowerCase()}`,
      title: ERROR_DEFINITIONS.INTERNAL_ERROR.code,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: ERROR_DEFINITIONS.INTERNAL_ERROR.defaultMessage,
      instance: path,
      code: ERROR_DEFINITIONS.INTERNAL_ERROR.code,
      traceId,
      timestamp: new Date().toISOString(),
    };
  }

  private log(
    status: number,
    method: string,
    path: string,
    code: string,
    exception: unknown,
  ): void {
    const message = `${method} ${path} -> ${status} ${code}`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        message,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(message);
    }
  }
}

const httpStatusOf = (exception: unknown): number =>
  exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

const codeOf = (exception: unknown): string =>
  exception instanceof AppException ? exception.code : 'INTERNAL_ERROR';

/**
 * Message returned to a gRPC caller.
 *
 * @remarks An unrecognised error is replaced with a generic message: a gRPC error body
 * reaches the client, and a raw stack or connection string in it is a disclosure the HTTP
 * path avoids by construction.
 */
const messageOf = (exception: unknown): string => {
  if (exception instanceof AppException || exception instanceof HttpException) {
    return exception.message;
  }
  return ERROR_DEFINITIONS.INTERNAL_ERROR.defaultMessage;
};
