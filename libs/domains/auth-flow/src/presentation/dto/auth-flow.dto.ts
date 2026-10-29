/**
 * @fileoverview Translation from an application outcome to the wire message.
 *
 * @remarks The proto's `FlowResponse` has every field optional and no way to say "there is no
 * session here". This is where that gap is closed deliberately: a field is emitted only when
 * the outcome actually carries it, so "no token" is an absent key rather than an empty string
 * that a caller has to know not to forward to an `Authorization` header.
 */
import type { FlowResponse } from '@auth/contracts';
import type { FlowOutcome } from '../../application/commands/auth-flow.commands';

export function toFlowResponse(outcome: FlowOutcome): FlowResponse {
  const tokens = outcome.session;

  return {
    flowId: outcome.flowId,
    state: outcome.state,
    flow: outcome.flow,
    ...(tokens
      ? {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          sessionId: tokens.sessionId,
          expiresIn: tokens.expiresIn,
        }
      : {}),
    message: outcome.message,
    retryable: outcome.retryable,
    ...(outcome.locked
      ? { locked: true, retryAfterSeconds: outcome.retryAfterSeconds }
      : {}),
  };
}