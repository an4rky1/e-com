/**
 * @fileoverview Translates a peer's transport failure into the two shapes a caller can act on.
 *
 * @remarks Both are about the peer, not the caller's request: the peer did not answer in time,
 * or could not be reached at all. Anything that is not a gRPC status is returned untouched —
 * masking a wiring bug as an outage would send callers into a retry that can never succeed.
 *
 * @remarks One implementation for the domain libs that call peers over `GrpcChannel` directly:
 * `PeerCaller` in `libs/gateway` translates through a different table because the gateway's
 * answers are caller-facing codes rather than "the peer is not there" flags.
 */
import {
  DependencyTimeoutException,
  DependencyUnavailableException,
} from '@auth/platform/error-handling';
import { GrpcStatus } from './grpc-channel.port';
import { statusCodeOf } from './nest-grpc-channel';

export function translatePeerError(error: unknown, method: string, peer?: string): unknown {
  if (typeof (error as { code?: unknown } | null)?.code !== 'number') {
    return error;
  }

  const status = statusCodeOf(error);
  const who = peer ?? method.split('/')[1]?.split('.')[0] ?? 'peer';

  if (status === GrpcStatus.DEADLINE_EXCEEDED) {
    return new DependencyTimeoutException(`${who} did not answer in time`, { method }, error);
  }

  if (status === GrpcStatus.UNAVAILABLE || status === GrpcStatus.UNIMPLEMENTED) {
    return new DependencyUnavailableException(`${who} could not be reached`, { method }, error);
  }

  return error;
}
