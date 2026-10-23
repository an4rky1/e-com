/**
 * @fileoverview One person's walk through authentication.
 *
 * @remarks The gateway owns this aggregate and nothing else. It does not know what a password
 * hash is, whether a user exists, or what a token looks like — it asks identity,
 * credential-vault, mfa and session-token over gRPC and records the answers as steps. That
 * boundary is the point: if the gateway stored any of those facts, "who may sign in" and "who
 * is signed in" would become one table, and no amount of careful code would separate them
 * again.
 *
 * @remarks Every state change goes through {@link AuthFlow.transition}, which validates it
 * against {@link AUTH_FLOW_TRANSITIONS}. There is no second way to move this aggregate — no
 * direct assignment of `state`, no handler-side check that could be forgotten — which is what
 * makes "an illegal transition throws" a property of the type rather than a convention.
 *
 * @remarks {@link InvalidStateTransitionException} is raised straight from here, unlike the
 * other services in this workspace, which let the domain raise a `DomainError` and translate
 * it at the boundary. The transition refusal is this service's *published* behaviour — it is
 * what `AdvanceFlow` resolves with, what an operator sees, and what every test asserts — so
 * raising one type from one place is worth more here than the extra hop buys.
 */

import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/core';
import { InvalidStateTransitionException } from '@auth/platform/error-handling';
import type { AuthFlowChangedPayload } from '@auth/contracts';
import {
  assertTransition,
  AuthFlowState,
  isTerminalState,
  type AuthFlowState as AuthFlowStateT,
} from './value-objects/auth-flow-state.vo';
import { AuthFlowId } from './value-objects/auth-flow-id.vo';
import {
  type AuthFlowType,
  INITIAL_STATE_BY_TYPE,
  isAuthFlowType,
  issuesSession,
} from './value-objects/auth-flow-type.vo';
import {
  FLOW_ORIGIN,
  FlowStep,
  recordStep,
  type FlowStepEntry,
} from './value-objects/flow-step.vo';

/** Aggregate/event identity constants — the prefix that scopes every auth-flow event. */
export const AUTH_FLOW_AGGREGATE = 'AuthFlow';

/** Written to `auth_flows.failure_reason` when the attempt budget ran out. */
export const MAX_ATTEMPTS_REASON = 'max_attempts_exhausted';

/**
 * @remarks The payload is `AuthFlowChangedPayload` from the integration contract, verbatim.
 *
 * @remarks It carries the flow, the user and the state — and nothing else. No password, no OTP,
 * no access token: an event payload is written to a table, relayed by a broker, and read by
 * every subscribed service, so anything secret in it is secret in roughly six places. Tokens
 * are returned to the caller on the response instead, where they go straight back to the
 * person who proved the factor.
 */
export class AuthFlowStarted extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: AuthFlowChangedPayload,
    version = 1,
  ) {
    super(aggregateId, AUTH_FLOW_AGGREGATE, 'auth_flow.started', version);
  }
}

export class AuthFlowStepCompleted extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: AuthFlowChangedPayload,
    version = 1,
  ) {
    super(aggregateId, AUTH_FLOW_AGGREGATE, 'auth_flow.step_completed', version);
  }
}

export class AuthFlowCompleted extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: AuthFlowChangedPayload,
    version = 1,
  ) {
    super(aggregateId, AUTH_FLOW_AGGREGATE, 'auth_flow.completed', version);
  }
}

/**
 * The flow stopped without completing — refused, timed out or abandoned.
 *
 * @remarks One event for all three terminal states because the topic catalogue has exactly one
 * terminal topic, `platform.auth_flow.failed.v1`. A consumer that needed to tell a failed login
 * from an abandoned one reads `payload.state`, which carries the distinction; a second event
 * type on the same topic would mean two payload shapes for one subscription.
 */
export class AuthFlowEnded extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: AuthFlowChangedPayload,
    version = 1,
  ) {
    super(aggregateId, AUTH_FLOW_AGGREGATE, 'auth_flow.failed', version);
  }
}

export interface AuthFlowProps {
  flow: AuthFlowType;
  state: AuthFlowStateT;
  userId: string | null;
  deviceId: string | null;
  clientIp: string | null;
  userAgent: string | null;
  attemptCount: number;
  maxAttempts: number;
  startedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
  abortReason: string | null;
  version: number;
  steps: FlowStepEntry[];
}

/** One `auth_flows` row, plus its `auth_flow_steps` when the repository fetched them. */
export interface AuthFlowRow {
  id: string;
  strategy: string;
  status: string;
  user_id: string | null;
  device_id: string | null;
  client_ip: string | null;
  user_agent: string | null;
  attempt_count: number;
  max_attempts: number;
  started_at: Date;
  updated_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  failure_reason: string | null;
  abort_reason: string | null;
  version: number;
  auth_flow_steps?: AuthFlowStepRow[];
}

export interface AuthFlowStepRow {
  id: bigint;
  flow_id: string;
  from_status: string;
  to_status: string;
  occurred_at: Date;
}

/**
 * The state machine, as an aggregate.
 *
 * @remarks The consistency boundary is the flow *and its steps*: `auth_flow_steps` is not a log
 * table that a caller may append to, it is part of what this aggregate is. A state change
 * whose audit row could fail to be written would let a flow reach `completed` with no record
 * of how — which is the only question an authentication audit is ever asked.
 */
export class AuthFlow extends AggregateRoot<AuthFlowId> {
  private constructor(
    id: AuthFlowId,
    private readonly props: AuthFlowProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * Opens a flow.
   *
   * @remarks `ttlMs` and `maxAttempts` are arguments rather than configuration read here: the
   * domain decides how long a flow may live from policy the caller supplies, so a test can
   * open a flow that expires in a millisecond without touching the clock or the environment.
   */
  static start(input: {
    flow: AuthFlowType;
    /** Required by `step_up`: there is no "look this person up" in a step-up. */
    userId?: string | null;
    deviceId?: string | null;
    clientIp?: string | null;
    userAgent?: string | null;
    ttlMs: number;
    maxAttempts?: number;
    id?: string;
    now?: Date;
  }): AuthFlow {
    Ensure.notEmpty(input.flow, 'flow');
    Ensure.isTrue(
      isAuthFlowType(input.flow),
      `unknown auth flow type "${String(input.flow)}"`,
      'INVALID_VALUE',
    );
    Ensure.positive(input.ttlMs, 'ttlMs');
    Ensure.positive(input.maxAttempts ?? 5, 'maxAttempts');

    const now = input.now ?? new Date();
    const id = AuthFlowId.create(input.id);
    const state = INITIAL_STATE_BY_TYPE[input.flow];

    const flow = new AuthFlow(
      id,
      {
        flow: input.flow,
        state,
        userId: input.userId ?? null,
        deviceId: input.deviceId ?? null,
        clientIp: input.clientIp ?? null,
        userAgent: input.userAgent ?? null,
        attemptCount: 0,
        maxAttempts: input.maxAttempts ?? 5,
        startedAt: now,
        expiresAt: new Date(now.getTime() + input.ttlMs),
        completedAt: null,
        failureReason: null,
        abortReason: null,
        version: 1,
        steps: [recordStep(FlowStep.STARTED, FLOW_ORIGIN, state, now)],
      },
      now,
      now,
    );

    flow.addDomainEvent(
      new AuthFlowStarted(id.value, flow.payload(state), 1),
    );

    return flow;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: AuthFlowRow): AuthFlow {
    const steps = [...(row.auth_flow_steps ?? [])]
      .sort(
        (a, b) =>
          a.occurred_at.getTime() - b.occurred_at.getTime() ||
          Number(a.id - b.id),
      )
      .map<FlowStepEntry>((entry) =>
        recordStep(
          stepNameOf(entry.to_status),
          entry.from_status as FlowStepEntry['from'],
          entry.to_status as AuthFlowStateT,
          entry.occurred_at,
        ),
      );

    return new AuthFlow(
      AuthFlowId.fromStored(row.id),
      {
        flow: row.strategy as AuthFlowType,
        state: row.status as AuthFlowStateT,
        userId: row.user_id,
        deviceId: row.device_id,
        clientIp: row.client_ip,
        userAgent: row.user_agent,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        completedAt: row.completed_at,
        failureReason: row.failure_reason,
        abortReason: row.abort_reason,
        version: row.version,
        steps,
      },
      row.started_at,
      row.updated_at,
    );
  }

  // ---- reads ---------------------------------------------------------------------

  get flow(): AuthFlowType {
    return this.props.flow;
  }

  get state(): AuthFlowStateT {
    return this.props.state;
  }

  get userId(): string | null {
    return this.props.userId;
  }

  get deviceId(): string | null {
    return this.props.deviceId;
  }

  get clientIp(): string | null {
    return this.props.clientIp;
  }

  get userAgent(): string | null {
    return this.props.userAgent;
  }

  get attemptCount(): number {
    return this.props.attemptCount;
  }

  get maxAttempts(): number {
    return this.props.maxAttempts;
  }

  get startedAt(): Date {
    return this.props.startedAt;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get completedAt(): Date | null {
    return this.props.completedAt;
  }

  get failureReason(): string | null {
    return this.props.failureReason;
  }

  get abortReason(): string | null {
    return this.props.abortReason;
  }

  /** The audit trail, oldest first. */
  get steps(): readonly FlowStepEntry[] {
    return this.props.steps;
  }

  /**
   * The row version, as persisted.
   *
   * @remarks Shadows `AggregateRoot.version`, which counts *buffered* events and therefore
   * reads `0` immediately after `clearDomainEvents()` — the wrong number to write to a
   * `version` column, and the wrong number to build a `dedup_key` from.
   */
  override get version(): number {
    return this.props.version;
  }

  get isTerminal(): boolean {
    return isTerminalState(this.props.state);
  }

  /** Whether the lifetime has run out. A flow past its TTL may never advance again. */
  isExpiredAt(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  /** Whether completing this flow mints a session. False for step-up, register and reset. */
  get issuesSession(): boolean {
    return issuesSession(this.props.flow);
  }

  /** Whether a second factor is outstanding. */
  get isAwaitingFactor(): boolean {
    return (
      this.props.state === AuthFlowState.AWAITING_2FA ||
      this.props.state === AuthFlowState.AWAITING_STEP_UP
    );
  }

  // ---- writes --------------------------------------------------------------------

  /**
   * Remembers who this flow turned out to be for.
   *
   * @remarks Separate from a transition because it is not one: a login learns the user's id
   * while still in `awaiting_credential`, and forcing a state change to record it would invent
   * a state that means nothing.
   */
  attachUser(userId: string, now: Date = new Date()): void {
    Ensure.notEmpty(userId, 'userId');
    if (this.props.userId === userId) return;
    this.props.userId = userId;
    this.bump(now);
  }

  /**
   * Counts one use of this flow against its attempt budget.
   *
   * @remarks The budget is per *flow row*, not per session: it exists so a single row cannot
   * be used as an oracle for a password by an attacker who found its id. Once it is spent the
   * flow fails and the caller must open a new one, which is where the rate limiting that stops
   * the guessing itself lives.
   *
   * @remarks Not a state change on purpose — a rejected guess that has not yet exhausted the
   * budget leaves the flow exactly where it was, still `awaiting_credential`, so the caller can
   * try again against the same row.
   */
  registerAttempt(now: Date): void {
    this.assertAdvanceable(now);

    if (this.props.attemptCount >= this.props.maxAttempts) {
      this.fail(MAX_ATTEMPTS_REASON, now);
      return;
    }

    this.props.attemptCount += 1;
    this.bump(now);
  }

  /**
   * A secret was accepted, but a second factor is outstanding.
   *
   * @remarks Legal only from `awaiting_credential`: by the time a flow is in `awaiting_2fa` the
   * credential has already done its job, and asking for it again would let a flow be pushed
   * back a step it has passed.
   */
  requireSecondFactor(now: Date = new Date()): void {
    this.assertAdvanceable(now);
    this.transition(
      AuthFlowState.AWAITING_2FA,
      FlowStep.CREDENTIAL_VERIFIED,
      now,
    );
  }

  /**
   * Pauses the flow until a sensitive action's factor is re-proved.
   *
   * @remarks Reachable from `awaiting_credential` and `awaiting_2fa` but *not* from
   * `awaiting_step_up` — see {@link AUTH_FLOW_TRANSITIONS}. A step-up that could be satisfied
   * by the factor it just demanded is not a step-up.
   */
  requireStepUp(now: Date = new Date()): void {
    this.assertAdvanceable(now);
    this.transition(
      AuthFlowState.AWAITING_STEP_UP,
      FlowStep.STEP_UP_REQUESTED,
      now,
    );
  }

  /**
   * Finishes the flow.
   *
   * @remarks Marks the proof that the outstanding factor was accepted. It records nothing about
   * tokens: whether a session is issued is decided by {@link issuesSession} and by the caller,
   * and the aggregate deliberately does not know a token from a step name.
   */
  complete(now: Date = new Date()): void {
    this.assertAdvanceable(now);
    this.transition(AuthFlowState.COMPLETED, FlowStep.COMPLETED, now);
    this.props.completedAt = now;
    this.addDomainEvent(
      new AuthFlowCompleted(
        this.id.value,
        this.payload(AuthFlowState.COMPLETED),
        this.props.version,
      ),
    );
  }

  /**
   * Refuses the flow.
   *
   * @remarks `reason` is written to `failure_reason` and published in the event payload, so it
   * must name what happened — `invalid_credentials`, `invalid_second_factor` — and never why a
   * particular guess was wrong.
   */
  fail(reason: string, now: Date = new Date()): void {
    Ensure.notEmpty(reason, 'reason');
    this.transition(AuthFlowState.FAILED, FlowStep.FAILED, now, reason);
    this.props.failureReason = reason;
    this.addDomainEvent(
      new AuthFlowEnded(
        this.id.value,
        this.payload(AuthFlowState.FAILED, reason),
        this.props.version,
      ),
    );
  }

  /** Abandons the flow at the caller's request. */
  cancel(reason: string, now: Date = new Date()): void {
    Ensure.notEmpty(reason, 'reason');
    this.transition(AuthFlowState.CANCELLED, FlowStep.CANCELLED, now, reason);
    this.props.abortReason = reason;
    this.addDomainEvent(
      new AuthFlowEnded(
        this.id.value,
        this.payload(AuthFlowState.CANCELLED, reason),
        this.props.version,
      ),
    );
  }

  /** Retires a flow whose lifetime has run out. */
  expire(now: Date = new Date()): void {
    this.transition(
      AuthFlowState.EXPIRED,
      FlowStep.EXPIRED,
      now,
      'ttl_elapsed',
    );
    this.addDomainEvent(
      new AuthFlowEnded(
        this.id.value,
        this.payload(AuthFlowState.EXPIRED, 'ttl_elapsed'),
        this.props.version,
      ),
    );
  }

  /**
   * Retires the flow if — and only if — its lifetime has run out.
   *
   * @remarks Returns whether it moved, so the caller knows whether there is anything to
   * persist. The alternative (throwing) would lose the record of *why* the flow is dead, which
   * is the one thing worth writing down.
   */
  expireIfDue(now: Date = new Date()): boolean {
    if (this.isTerminal || !this.isExpiredAt(now)) return false;
    this.expire(now);
    return true;
  }

  /**
   * The gate in front of every advancement.
   *
   * @throws InvalidStateTransitionException when the flow has already finished, or when its
   * lifetime has run out. Checked on *every* entry point rather than once per handler, because
   * a rule that is enforced at four call sites is a rule that will be enforced at three.
   */
  assertAdvanceable(now: Date): void {
    if (this.isTerminal) {
      throw new InvalidStateTransitionException(
        `auth flow is ${this.props.state} and cannot be advanced`,
        {
          flowId: this.id.value,
          flow: this.props.flow,
          state: this.props.state,
          expiresAt: this.props.expiresAt.toISOString(),
        },
      );
    }

    if (this.isExpiredAt(now)) {
      throw new InvalidStateTransitionException('auth flow has expired', {
        flowId: this.id.value,
        flow: this.props.flow,
        state: this.props.state,
        expiresAt: this.props.expiresAt.toISOString(),
      });
    }
  }

  /**
   * The single point of movement.
   *
   * @remarks Every mutation that is a transition lands here, so an illegal edge cannot be
   * reached by any other route. The audit row is appended in the same breath as the state
   * change: a row written later could fail on its own, and a flow that moved without a record
   * of how is exactly the flow nobody can audit.
   */
  private transition(
    to: AuthFlowStateT,
    step: FlowStep,
    now: Date,
    reason?: string,
  ): void {
    const from = this.props.state;
    assertTransition(from, to, {
      flowId: this.id.value,
      flow: this.props.flow,
    });

    this.props.state = to;
    this.bump(now);
    this.props.steps.push(recordStep(step, from, to, now));
    this.addDomainEvent(
      new AuthFlowStepCompleted(
        this.id.value,
        this.payload(to, reason),
        this.props.version,
      ),
    );
  }

  /** Every mutation goes through here, so `version` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }

  /** The integration payload. Carries no credential, no token and no reason for a rejection. */
  private payload(state: AuthFlowStateT, reason?: string): AuthFlowChangedPayload {
    return {
      flowId: this.id.value,
      userId: this.props.userId ?? undefined,
      flow: this.props.flow,
      state,
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

export type AuthFlowEvent =
  | AuthFlowStarted
  | AuthFlowStepCompleted
  | AuthFlowCompleted
  | AuthFlowEnded;

export const isAuthFlowEvent = (event: IDomainEvent): event is AuthFlowEvent =>
  event.aggregateType === AUTH_FLOW_AGGREGATE;

/**
 * Recovers the step name from a stored audit row.
 *
 * @remarks `auth_flow_steps` records states, not step names — the schema was pulled from the
 * live database and carries no step column. Rather than lose the distinction on reload, the
 * name is derived from the state the row moved *to*: the terminal states are their own steps,
 * and the three waiting states name the proof that produces them. A row that leaves a flow in
 * `awaiting_credential` can only be the opening one, because nothing moves *back* into it.
 */
function stepNameOf(toStatus: string): FlowStep {
  switch (toStatus) {
    case AuthFlowState.AWAITING_2FA:
      return FlowStep.CREDENTIAL_VERIFIED;
    case AuthFlowState.AWAITING_STEP_UP:
      return FlowStep.STEP_UP_REQUESTED;
    case AuthFlowState.COMPLETED:
      return FlowStep.TWO_FACTOR_VERIFIED;
    case AuthFlowState.FAILED:
      return FlowStep.FAILED;
    case AuthFlowState.EXPIRED:
      return FlowStep.EXPIRED;
    case AuthFlowState.CANCELLED:
      return FlowStep.CANCELLED;
    default:
      return FlowStep.STARTED;
  }
}