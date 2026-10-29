/**
 * @fileoverview The three write paths of the gateway, and the whole of its orchestration.
 *
 * @remarks This file is where the flow *meets* the rest of the platform. It asks identity who
 * the person is, asks credential-vault whether the secret was right, asks mfa whether a factor
 * is outstanding, and asks session for a pair of tokens — and it never touches any of
 * them directly, only through the ports in `domain/ports/`.
 *
 * @remarks Two rules run through every handler here:
 *
 * 1. **The aggregate decides; the handler asks.** Nothing in this file writes a state, checks
 *    whether a transition is legal, or decides whether a flow may be advanced. That is the
 *    state machine's job, and duplicating any of it here would create a second set of rules to
 *    keep in step with the first.
 * 2. **A refusal is the same refusal.** Unknown address, wrong password and refused factor all
 *    produce `failed` with one message. The *reasons* differ and are recorded, because an
 *    operator needs them; the answer the caller gets does not, because a caller who can tell
 *    them apart turns sign-in into a way to enumerate accounts.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import type { IClock } from '@auth/core';
import { AuthFlow } from '../../domain/auth-flow.aggregate';
import {
  AUTH_FLOW_REPOSITORY,
  type AuthFlowRepositoryPort,
} from '../../domain/ports/auth-flow-repository.port';
import { CLOCK } from '../../domain/ports/clock.port';
import {
  CREDENTIAL_PORT,
  type CredentialPort,
} from '../../domain/ports/credential.port';
import { IDENTITY_PORT, type IdentityPort } from '../../domain/ports/identity.port';
import { MFA_PORT, type MfaPort } from '../../domain/ports/mfa.port';
import {
  ACCOUNT_SECURITY_PORT,
  type AccountLockState,
  type AccountSecurityPort,
} from '../../domain/ports/account-security.port';
import {
  SESSION_PORT,
  type IssuedTokens,
  type SessionPort,
} from '../../domain/ports/session.port';
import { AuthFlowState } from '../../domain/value-objects/auth-flow-state.vo';
import {
  AuthFlowType,
  isAuthFlowType,
  SECOND_FACTOR_TYPES,
} from '../../domain/value-objects/auth-flow-type.vo';
import {
  AUTH_FLOW_CONFIG,
  type AuthFlowConfig,
} from '../../auth-flow.config';
import {
  AdvanceFlowCommand,
  CancelFlowCommand,
  isRetryable,
  messageFor,
  StartFlowCommand,
  type FlowOutcome,
} from './auth-flow.commands';

// ---- start ----------------------------------------------------------------------

@Injectable()
@CommandHandler(StartFlowCommand)
export class StartFlowHandler implements ICommandHandler<StartFlowCommand, FlowOutcome> {
  private readonly logger = new Logger(StartFlowHandler.name);

  constructor(
    @Inject(AUTH_FLOW_REPOSITORY) private readonly flows: AuthFlowRepositoryPort,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(CLOCK) private readonly clock: IClock,
    @Inject(AUTH_FLOW_CONFIG) private readonly config: AuthFlowConfig,
  ) {}

  /**
   * Opens a flow, and answers nothing about whether the person exists.
   *
   * @remarks The lookup happens *here*, at the point where the email is still in the request,
   * because that is the only moment it will be available: `auth_flows` has no email column and
   * `AdvanceFlow` carries only a credential. Resolving here also means the flow row records
   * who it is for before a single guess is spent against it.
   *
   * @remarks An address with no account still yields a live flow, with no user attached. The
   * refusal happens when the credential arrives, so that "no such user" and "wrong password"
   * cost the caller the same and produce the same answer.
   */
  async execute(command: StartFlowCommand): Promise<FlowOutcome> {
    if (!isAuthFlowType(command.flow)) {
      throw new ValidationException(`unknown auth flow "${command.flow}"`, {
        flow: command.flow,
      });
    }
    const flow: AuthFlowType = command.flow;

    let userId = command.userId ?? null;
    if (flow === AuthFlowType.STEP_UP) {
      if (!userId) {
        // A step-up has no address to look up: it is driven by a caller who is already
        // authenticated and is naming the account they are re-proving.
        throw new ValidationException('step_up requires a userId', { flow });
      }
    } else {
      userId = (await this.identity.findUserByEmail(command.email ?? ''))?.id ?? null;
    }

    const aggregate = AuthFlow.start({
      flow,
      userId,
      deviceId: command.deviceId ?? null,
      clientIp: command.clientIp ?? null,
      userAgent: command.userAgent ?? null,
      ttlMs: this.config.flowTtlMs,
      maxAttempts: this.config.maxAttempts,
      now: this.clock.now(),
    });

    await this.flows.save(aggregate);
    this.logger.log(`auth flow ${aggregate.id.value} opened for ${flow}`);

    return outcomeOf(aggregate, null);
  }
}

// ---- advance --------------------------------------------------------------------

@Injectable()
@CommandHandler(AdvanceFlowCommand)
export class AdvanceFlowHandler implements ICommandHandler<AdvanceFlowCommand, FlowOutcome> {
  private readonly logger = new Logger(AdvanceFlowHandler.name);

  constructor(
    @Inject(AUTH_FLOW_REPOSITORY) private readonly flows: AuthFlowRepositoryPort,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(CREDENTIAL_PORT) private readonly credentials: CredentialPort,
    @Inject(MFA_PORT) private readonly mfa: MfaPort,
    @Inject(SESSION_PORT) private readonly sessions: SessionPort,
    @Inject(CLOCK) private readonly clock: IClock,
    // Optional: a host that has not wired account-security (a unit test, a focused deployment)
    // still boots, and the flow simply does not enforce a lock.
    @Optional()
    @Inject(ACCOUNT_SECURITY_PORT)
    private readonly security?: AccountSecurityPort,
  ) {}

  async execute(command: AdvanceFlowCommand): Promise<FlowOutcome> {
    const now = this.clock.now();
    const flow = await this.load(command.flowId);

    // A flow past its lifetime is retired before anything else is attempted, and the
    // retirement is written down: an expired flow that silently did nothing is
    // indistinguishable from one that was never asked about.
    if (flow.expireIfDue(now)) {
      await this.flows.save(flow);
      return outcomeOf(flow, null);
    }

    // Throws for a flow that is already completed, failed, cancelled or expired. Reaching here
    // means the flow is genuinely open and still within its TTL.
    flow.assertAdvanceable(now);
    flow.registerAttempt(now);

    // The budget may have just been spent, in which case `registerAttempt` failed the flow and
    // there is nothing left to verify against.
    if (flow.state === AuthFlowState.FAILED) {
      await this.flows.save(flow);
      return outcomeOf(flow, null);
    }

    const credential = command.credential ?? '';
    // An empty submission is refused exactly as a wrong one is. Sending it on to the vault
    // would spend a downstream call to arrive at the same answer, and would make "the client
    // sent nothing" a distinguishable outcome.
    if (credential.trim().length === 0) {
      return this.refuse(flow, 'invalid_credentials', now);
    }

    const outcome = await this.advanceByState(flow, credential, now);

    // Reported after the outcome, not before: the counters have to count the attempt that
    // actually happened, and a lock is only meaningful against a flow that has finished.
    return this.recordAndEnforce(flow, outcome);
  }

  private async advanceByState(
    flow: AuthFlow,
    credential: string,
    now: Date,
  ): Promise<FlowOutcome> {
    switch (flow.state) {
      case AuthFlowState.AWAITING_CREDENTIAL:
        return this.satisfyCredential(flow, credential, now);
      case AuthFlowState.AWAITING_2FA:
        return this.satisfySecondFactor(flow, credential, now);
      case AuthFlowState.AWAITING_STEP_UP:
        return this.satisfyStepUp(flow, credential, now);
      default:
        // Unreachable: `assertAdvanceable` has already excluded every other state, and the
        // switch is exhaustive over what is left. Spelled out so a future state fails here
        // rather than silently completing a flow nobody checked.
        throw new ResourceNotFoundException('auth flow cannot be advanced', {
          flowId: flow.id.value,
          state: flow.state,
        });
    }
  }

  /**
   * Reports a sign-in to account-security, and carries that service's lock back in the outcome.
   *
   * @remarks A lock travels as state rather than as an exception. `failed`, `expired` and
   * `cancelled` are outcomes of a walk someone started, and this file already answers every one
   * of them with a `FlowResponse` — an exception would hand the caller a gRPC status instead,
   * and gRPC has no code for "locked". The edge is where an outcome becomes an HTTP status,
   * which is also where the seconds below can reach the client without a second round trip.
   *
   * @remarks The lock is read back rather than predicted. The counters live in Redis and the
   * lockout is account-security's decision, so this is the only place that can know — a local
   * copy of the threshold would be a second policy that drifts from the first the day somebody
   * changes one and not the other.
   *
   * @remarks Only `login` flows are recorded. A registration, a reset or a step-up completing is
   * not a sign-in, and filing it under the login history would make the history useless to the
   * incident review that reads it.
   *
   * @remarks An unreachable account-security is logged and allowed through. The per-address rate
   * limiter at the edge is the first line against guessing and does not depend on this service;
   * refusing every login because the audit store is down would trade a brute-force window for an
   * outage, and the window is already partly closed by the limiter.
   */
  private async recordAndEnforce(
    flow: AuthFlow,
    outcome: FlowOutcome,
  ): Promise<FlowOutcome> {
    if (this.security === undefined) return outcome;
    if (flow.flow !== AuthFlowType.LOGIN) return outcome;
    if (flow.clientIp === null) return outcome;

    const succeeded = outcome.state === AuthFlowState.COMPLETED;

    let lock: AccountLockState;
    try {
      lock = await this.security.recordAttempt({
        userId: flow.userId,
        email: '',
        ipAddress: flow.clientIp,
        deviceFingerprint: flow.deviceId ?? undefined,
        succeeded,
      });
    } catch (error) {
      this.logger.error(
        `account-security unreachable; the attempt is not recorded. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return outcome;
    }

    // A lock is only reported for a failed attempt: a completed flow has already cleared the
    // counters, so a lock reported alongside it would be a lock that was just lifted.
    if (lock.locked && !succeeded) {
      return { ...outcome, locked: true, retryAfterSeconds: lock.retryAfterSeconds };
    }

    return outcome;
  }

  /**
   * The flow is in `awaiting_credential`.
   *
   * @remarks Registration is the odd one out: the account usually does not exist yet, so there
   * is nothing to verify a password against and the flow goes straight to its second factor.
   */
  private async satisfyCredential(
    flow: AuthFlow,
    credential: string,
    now: Date,
  ): Promise<FlowOutcome> {
    const userId = flow.userId;

    if (flow.flow === AuthFlowType.REGISTER) {
      // An address that already has an account is refused with the same message as anything
      // else. Reporting it separately would turn the endpoint into "does this person have an
      // account here", which is the one question sign-in must not answer.
      if (userId !== null) {
        return this.refuse(flow, 'account_unavailable', now);
      }
      flow.requireSecondFactor(now);
      await this.flows.save(flow);
      return outcomeOf(flow, null);
    }

    if (userId === null) {
      return this.refuse(flow, 'invalid_credentials', now);
    }

    if (flow.flow === AuthFlowType.MAGIC_LINK) {
      // The link's own signature and expiry are proven wherever it was minted; the gateway's
      // job is to record that it was presented against a live flow, not to re-derive the proof.
      // The capability check belongs to the caller that minted the token.
      return this.finish(flow, now);
    }

    const verdict = await this.credentials.verifyPassword({
      userId,
      password: credential,
    });

    if (!verdict.valid) {
      return this.refuse(flow, 'invalid_credentials', now);
    }

    // A flow that is about to change what this account is trusted with — a fresh registration,
    // a new password — must prove the mailbox before it may do so.
    if (SECOND_FACTOR_TYPES.has(flow.flow)) {
      flow.requireSecondFactor(now);
      await this.flows.save(flow);
      return outcomeOf(flow, null);
    }

    if (flow.flow === AuthFlowType.LOGIN && (await this.mfa.isEnabled({ userId }))) {
      flow.requireSecondFactor(now);
      await this.flows.save(flow);
      return outcomeOf(flow, null);
    }

    return this.finish(flow, now);
  }

  /** The flow is in `awaiting_2fa`: a login the account's second factor guards. */
  private async satisfySecondFactor(
    flow: AuthFlow,
    credential: string,
    now: Date,
  ): Promise<FlowOutcome> {
    const userId = flow.userId;

    // A registration has no account to hold a factor yet — that is the whole point of the
    // flow. The code proves the mailbox, and identity re-checks it as it creates the account;
    // this service's contribution is the transition and the audit row recording that it
    // happened. Every other flow must already know who it is for, and one that does not is a
    // refused login rather than an anonymous success.
    if (userId === null) {
      if (flow.flow === AuthFlowType.REGISTER) {
        return this.finish(flow, now);
      }
      return this.refuse(flow, 'invalid_credentials', now);
    }

    const result = await this.mfa.verifyFactor({ userId, code: credential });
    if (!result.verified) {
      return this.refuse(flow, 'invalid_second_factor', now);
    }

    return this.finish(flow, now);
  }

  /**
   * The flow is in `awaiting_step_up`.
   *
   * @remarks The one path that deliberately does *not* mint a session. {@link AuthFlow.issuesSession}
   * is false for `step_up`, so `finish` completes the flow and issues nothing — which is the
   * whole point of a step-up: it proves a factor for an action the caller is already
   * authorised to take, and handing back a fresh pair of tokens would turn one stolen access
   * token into an unlimited supply of them.
   */
  private async satisfyStepUp(
    flow: AuthFlow,
    credential: string,
    now: Date,
  ): Promise<FlowOutcome> {
    const userId = flow.userId;
    if (userId === null) {
      return this.refuse(flow, 'invalid_credentials', now);
    }

    const result = await this.mfa.verifyFactor({ userId, code: credential });
    if (!result.verified) {
      return this.refuse(flow, 'invalid_step_up', now);
    }

    return this.finish(flow, now);
  }

  /**
   * Completes the flow, and mints a session only if the flow is one that earns one.
   *
   * @remarks Tokens are issued *before* the transition is persisted. They cannot join this
   * service's transaction — they belong to another database — so one of the two has to go
   * first. This order fails towards a session that outlives its audit row, which is visible and
   * revocable; the reverse would fail towards a `completed` flow that quietly handed out
   * nothing, and the person would just be mysteriously signed out.
   */
  private async finish(flow: AuthFlow, now: Date): Promise<FlowOutcome> {
    let tokens: IssuedTokens | null = null;

    if (flow.issuesSession && flow.userId !== null) {
      // `auth_flows` holds no address, so the email a token is minted with is read back from
      // the service that owns it. One lookup on the completion path is cheaper than persisting
      // an address this service does not own.
      const user = await this.identity.findUserById(flow.userId);
      tokens = await this.sessions.issueTokens({
        userId: flow.userId,
        email: user?.email ?? '',
        deviceId: flow.deviceId,
        ipAddress: flow.clientIp,
      });
    }

    flow.complete(now);
    await this.flows.save(flow);
    this.logger.log(`auth flow ${flow.id.value} completed for ${flow.flow}`);

    return outcomeOf(flow, tokens);
  }

  /** Fails the flow and returns the one answer every refusal gets. */
  private async refuse(flow: AuthFlow, reason: string, now: Date): Promise<FlowOutcome> {
    flow.fail(reason, now);
    await this.flows.save(flow);
    return outcomeOf(flow, null);
  }

  private async load(flowId: string): Promise<AuthFlow> {
    const flow = await this.flows.findById(flowId);
    if (!flow) {
      throw new ResourceNotFoundException('auth flow not found', { flowId });
    }
    return flow;
  }
}

// ---- cancel ---------------------------------------------------------------------

@Injectable()
@CommandHandler(CancelFlowCommand)
export class CancelFlowHandler implements ICommandHandler<CancelFlowCommand, FlowOutcome> {
  constructor(
    @Inject(AUTH_FLOW_REPOSITORY) private readonly flows: AuthFlowRepositoryPort,
    @Inject(CLOCK) private readonly clock: IClock,
  ) {}

  /**
   * Abandons a flow the person walked away from.
   *
   * @remarks Not idempotent, unlike logout. `cancelled -> cancelled` is not in the transition
   * table, so a retried cancel is *refused* rather than quietly accepted — the same rule every
   * other illegal move follows, and the reason a redelivered `CancelFlow` gets a clear answer
   * instead of a second `auth_flow.failed` for a fact already published.
   */
  async execute(command: CancelFlowCommand): Promise<FlowOutcome> {
    const flow = await this.flows.findById(command.flowId);
    if (!flow) {
      throw new ResourceNotFoundException('auth flow not found', {
        flowId: command.flowId,
      });
    }

    flow.cancel(command.reason, this.clock.now());
    await this.flows.save(flow);

    return outcomeOf(flow, null);
  }
}

// ---- shared ---------------------------------------------------------------------

function outcomeOf(flow: AuthFlow, session: IssuedTokens | null): FlowOutcome {
  return {
    flowId: flow.id.value,
    flow: flow.flow,
    state: flow.state,
    message: messageFor(flow.state),
    retryable: isRetryable(flow.state),
    session,
    locked: false,
    retryAfterSeconds: 0,
  };
}