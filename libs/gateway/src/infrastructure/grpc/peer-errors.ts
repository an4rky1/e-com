/**
 * @fileoverview Turns a gRPC failure into a stable platform error.
 *
 * @remarks **This is the only place in the gateway where a peer's failure is interpreted, and
 * it deliberately drops the error's own message.** A gRPC error carries whatever the peer
 * chose to say: a SQL fragment, an internal hostname, a stack prefix. Forwarded, it reaches
 * the browser. Replaced, it reaches a log the caller cannot read. So the message on every
 * error raised here is written here, from a status code the gateway understands.
 *
 * @remarks Every unreachable peer becomes a `503` with the code `DEPENDENCY_UNAVAILABLE` —
 * including a deadline. A `504` would tell the caller "the request may or may not have been
 * applied", which is exactly the wrong signal for an edge: by the time its deadline expires
 * the downstream call was abandoned before it could commit anything, so the honest answer is
 * "nothing happened, come back", and it is the same answer for a refused connection, which is
 * what lets one caller-facing code cover both.
 */
import {
  AppException,
  DependencyUnavailableException,
  InvalidStateTransitionException,
  PermissionDeniedException,
  RateLimitExceededException,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
  TokenInvalidException,
  ValidationException,
} from '@auth/platform/error-handling';
import { GrpcStatus, statusCodeOf, type GrpcStatusCode } from '@auth/infra/grpc';

const UNREACHABLE = (method: string) =>
  new DependencyUnavailableException('a required service could not be reached', {
    method,
  });

/**
 * Status -> exception.
 *
 * @remarks Absent entries fall through to an unclassified `INTERNAL_ERROR`, which is the
 * registry's loud 500 rather than a quiet client error.
 */
const EXCEPTION_BY_STATUS: Readonly<
  Partial<Record<GrpcStatusCode, (method: string) => AppException>>
> = {
  [GrpcStatus.UNAUTHENTICATED]: (method) =>
    new TokenInvalidException('the request could not be authenticated', { method }),
  [GrpcStatus.PERMISSION_DENIED]: (method) =>
    new PermissionDeniedException('insufficient permissions', { method }),
  [GrpcStatus.NOT_FOUND]: (method) =>
    new ResourceNotFoundException('the requested resource does not exist', { method }),
  [GrpcStatus.ALREADY_EXISTS]: (method) =>
    new ResourceAlreadyExistsException('the resource already exists', { method }),
  [GrpcStatus.INVALID_ARGUMENT]: (method) =>
    new ValidationException('the request was rejected as invalid', { method }),
  [GrpcStatus.FAILED_PRECONDITION]: (method) =>
    new InvalidStateTransitionException('the resource is not in a state that allows this', {
      method,
    }),
  [GrpcStatus.RESOURCE_EXHAUSTED]: (method) =>
    new RateLimitExceededException('too many requests in flight upstream', { method }),

  // The three "the peer is not there" answers. All of them are a 503 with one code, because
  // the caller's remedy is identical: nothing was applied, try again.
  [GrpcStatus.UNAVAILABLE]: UNREACHABLE,
  [GrpcStatus.DEADLINE_EXCEEDED]: UNREACHABLE,
  [GrpcStatus.UNIMPLEMENTED]: UNREACHABLE,
};

/**
 * Maps a peer failure onto a platform exception.
 *
 * @remarks The mapping depends on the *status* and nothing else — not on which method was
 * called, and not on what the gateway was trying to do. That restraint is load-bearing: the
 * temptation is to read `INVALID_ARGUMENT` as "the password was wrong" because that is what
 * it means on the login path, and the moment that special case exists, the same status on
 * `CreateUser` starts answering 401 for a malformed email. What the status *means* is the
 * peer's to decide; this only decides what the caller is told.
 *
 * @remarks "The password was wrong" is not in this file at all. auth-gateway reports it as a
 * flow that ended in `failed`, which the application layer turns into a 401 — where it can be
 * tested without a socket.
 *
 * @param error - whatever the channel rejected with.
 * @param method - the method path that was being called, kept as context. A method name is
 * part of this platform's public contract, so unlike the error's message it is safe to keep.
 */
export function translatePeerFailure(error: unknown, method: string): AppException {
  if (error instanceof AppException) return error;

  const build = EXCEPTION_BY_STATUS[statusCodeOf(error)];
  if (build) return build(method);

  // `UNKNOWN`, `CANCELLED`, `INTERNAL`, `DATA_LOSS`, or an error that was never a gRPC error
  // at all. The registry turns an unrecognised code into a loud 500, which is the right
  // default: a failure nobody classified should page somebody, not read as a client error.
  // The original is kept as `cause` for the log, never for the body.
  return new AppException({
    code: 'INTERNAL_ERROR',
    cause: error,
    context: { method, peerStatus: statusCodeOf(error) },
  });
}
