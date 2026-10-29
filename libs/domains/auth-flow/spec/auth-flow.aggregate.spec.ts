/**
 * @fileoverview The state machine, tested exhaustively.
 *
 * @remarks Two properties, and they are the two that matter for a service whose only job is to
 * decide whether a step is allowed:
 *
 * 1. Every legal edge in the table succeeds and lands in the state the table names.
 * 2. Every pair of states that is *not* in the table throws `InvalidStateTransitionException`
 *    — all thirty-four of them, including the seven self-transitions, rather than a
 *    representative handful.
 *
 * The second is asserted as one `it.each` over the full 7x7 matrix so that adding a state to
 * the table without adding it here is a failing suite, not a silent gap.
 */
import { InvalidStateTransitionException } from '@auth/platform/error-handling';
import { AuthFlow, MAX_ATTEMPTS_REASON } from '../src/domain/auth-flow.aggregate';
import {
  AUTH_FLOW_STATES,
  AUTH_FLOW_TRANSITIONS,
  assertTransition,
  AuthFlowState,
  canTransition,
  describeTransitionTable,
} from '../src/domain/value-objects/auth-flow-state.vo';
import { AuthFlowType } from '../src/domain/value-objects/auth-flow-type.vo';
import {
  FLOW_ORIGIN,
  FlowStep,
  describeSteps,
} from '../src/domain/value-objects/flow-step.vo';
import {
  FLOW_TTL_MS,
  FLOW_TTL_MS as TTL,
  flowRowOf,
  openFlow,
  T0,
  T1,
  T2,
  USER_ID,
} from './support/fakes';

/** A live flow sitting in any of the seven states. */
function flowIn(state: AuthFlowState): AuthFlow {
  const flow = openFlow();

  switch (state) {
    case AuthFlowState.AWAITING_CREDENTIAL:
      return flow;
    case AuthFlowState.AWAITING_2FA:
      flow.requireSecondFactor(T1);
      return flow;
    case AuthFlowState.AWAITING_STEP_UP:
      flow.requireStepUp(T1);
      return flow;
    case AuthFlowState.COMPLETED:
      flow.complete(T1);
      return flow;
    case AuthFlowState.FAILED:
      flow.fail('refused', T1);
      return flow;
    case AuthFlowState.EXPIRED:
      flow.expire(T1);
      return flow;
    case AuthFlowState.CANCELLED:
      flow.cancel('walked away', T1);
      return flow;
  }
}

/** The one method that performs the edge `flow -> to`. */
function apply(flow: AuthFlow, to: AuthFlowState, now: Date = T2): void {
  switch (to) {
    case AuthFlowState.AWAITING_2FA:
      flow.requireSecondFactor(now);
      return;
    case AuthFlowState.AWAITING_STEP_UP:
      flow.requireStepUp(now);
      return;
    case AuthFlowState.COMPLETED:
      flow.complete(now);
      return;
    case AuthFlowState.FAILED:
      flow.fail('refused', now);
      return;
    case AuthFlowState.EXPIRED:
      flow.expire(now);
      return;
    case AuthFlowState.CANCELLED:
      flow.cancel('walked away', now);
      return;
    case AuthFlowState.AWAITING_CREDENTIAL:
      throw new Error('no transition produces awaiting_credential');
  }
}

type StatePair = readonly [AuthFlowState, AuthFlowState];

const EVERY_PAIR: readonly StatePair[] = AUTH_FLOW_STATES.flatMap((from) =>
  AUTH_FLOW_STATES.map((to) => [from, to] as StatePair),
);

/** Every legal edge, as `[from, to]`, so `it.each` gets tuples rather than `string[]`. */
const LEGAL_PAIRS: readonly StatePair[] = describeTransitionTable().map((edge) => {
  const [from, to] = edge.split(' -> ');
  return [from as AuthFlowState, to as AuthFlowState] as StatePair;
});

const ILLEGAL_PAIRS: readonly StatePair[] = EVERY_PAIR.filter(
  ([from, to]) => !canTransition(from, to),
);

/**
 * The illegal pairs a public method can actually be asked to perform.
 *
 * @remarks Seven pairs are missing by construction rather than by omission: no method moves a
 * flow *back* into `awaiting_credential`, because nothing in the machine produces it. Those are
 * covered by the table assertion below, which asks the guard directly.
 */
const ILLEGAL_PAIRS_REACHABLE: readonly StatePair[] = ILLEGAL_PAIRS.filter(
  ([, to]) => to !== AuthFlowState.AWAITING_CREDENTIAL,
);

/** The seven that no method expresses: the guard still refuses every one. */
const ILLEGAL_PAIRS_BACKWARD: readonly StatePair[] = ILLEGAL_PAIRS.filter(
  ([, to]) => to === AuthFlowState.AWAITING_CREDENTIAL,
);

/** Every state that can be reached, paired with each target the table allows. */
const OPEN_STATES_ONLY: readonly AuthFlowState[] = AUTH_FLOW_STATES.filter(
  (state) => AUTH_FLOW_TRANSITIONS[state].length > 0,
);

// ---- the table itself -----------------------------------------------------------

describe('AUTH_FLOW_TRANSITIONS', () => {
  it('declares a row for every state', () => {
    expect(Object.keys(AUTH_FLOW_TRANSITIONS).sort()).toEqual([...AUTH_FLOW_STATES].sort());
  });

  it('has no edge out of a terminal state', () => {
    for (const state of [
      AuthFlowState.COMPLETED,
      AuthFlowState.FAILED,
      AuthFlowState.EXPIRED,
      AuthFlowState.CANCELLED,
    ]) {
      expect(AUTH_FLOW_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('never contains a self-transition', () => {
    for (const state of AUTH_FLOW_STATES) {
      expect(AUTH_FLOW_TRANSITIONS[state]).not.toContain(state);
    }
  });

  it('is fifteen edges long', () => {
    // 6 + 5 + 4 + 0 + 0 + 0 + 0. Pinned so that adding or removing an edge is a deliberate,
    // visible change rather than an accident that still type-checks.
    expect(describeTransitionTable()).toHaveLength(15);
  });
});

// ---- legal transitions ----------------------------------------------------------

describe('legal transitions', () => {
  it.each(LEGAL_PAIRS)(
    '%s -> %s succeeds and lands in the target state',
    (from, to) => {
      const flow = flowIn(from);
      const before = flow.state;

      apply(flow, to, T2);

      expect(before).toBe(from);
      expect(flow.state).toBe(to);
      expect(canTransition(from, to)).toBe(true);
    },
  );

  it.each(OPEN_STATES_ONLY)('%s reaches every state the table allows', (from) => {
    for (const to of AUTH_FLOW_TRANSITIONS[from]) {
      const flow = flowIn(from);
      apply(flow, to, T2);
      expect(flow.state).toBe(to);
    }
  });

  it('reaches every non-terminal state from a fresh login', () => {
    const reached = new Set<AuthFlowState>();
    for (const state of OPEN_STATES_ONLY) {
      reached.add(flowIn(state).state);
    }
    expect([...reached].sort()).toEqual([...OPEN_STATES_ONLY].sort());
  });
});

// ---- illegal transitions -------------------------------------------------------

describe('illegal transitions', () => {
  it.each(ILLEGAL_PAIRS)('%s -> %s is refused by the guard', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidStateTransitionException);
  });

  it.each(ILLEGAL_PAIRS_REACHABLE)(
    '%s -> %s throws InvalidStateTransitionException',
    (from, to) => {
      const flow = flowIn(from);

      expect(() => apply(flow, to, T2)).toThrow(InvalidStateTransitionException);
      // The refusal must leave the flow exactly where it was: a rejected transition that
      // half-applied would be worse than one that did nothing.
      expect(flow.state).toBe(from);
    },
  );

  it.each(ILLEGAL_PAIRS_BACKWARD)(
    '%s -> %s has no method that produces it, and the guard refuses it',
    (from, to) => {
      expect(() => assertTransition(from, to)).toThrow(
        InvalidStateTransitionException,
      );
    },
  );

  it('reaches every illegal pair through one of the two routes', () => {
    expect(ILLEGAL_PAIRS_REACHABLE.length + ILLEGAL_PAIRS_BACKWARD.length).toBe(
      ILLEGAL_PAIRS.length,
    );
  });

  it('names both states and the allowed targets in the guard error context', () => {
    try {
      assertTransition(AuthFlowState.COMPLETED, AuthFlowState.AWAITING_2FA);
      throw new Error('the transition should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateTransitionException);
      const context = (error as InvalidStateTransitionException).context;
      expect(context['from']).toBe(AuthFlowState.COMPLETED);
      expect(context['to']).toBe(AuthFlowState.AWAITING_2FA);
      expect(context['allowed']).toEqual([]);
    }
  });

  it('names the flow and its state when a finished flow is asked to move', () => {
    const flow = flowIn(AuthFlowState.COMPLETED);

    try {
      flow.requireSecondFactor(T2);
      throw new Error('the move should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStateTransitionException);
      const context = (error as InvalidStateTransitionException).context;
      expect(context['flowId']).toBe(flow.id.value);
      expect(context['state']).toBe(AuthFlowState.COMPLETED);
      expect(context['expiresAt']).toBe(flow.expiresAt.toISOString());
    }
  });

  it.each([
    [AuthFlowState.COMPLETED, AuthFlowState.AWAITING_2FA],
    [AuthFlowState.COMPLETED, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowState.FAILED, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowState.EXPIRED, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowState.CANCELLED, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowState.AWAITING_2FA, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowState.AWAITING_STEP_UP, AuthFlowState.AWAITING_2FA],
    [AuthFlowState.AWAITING_STEP_UP, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowState.AWAITING_CREDENTIAL, AuthFlowState.AWAITING_CREDENTIAL],
  ] as StatePair[])('refuses the specifically-called-out edge %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidStateTransitionException);
  });

  it('covers every state pair exactly once: 49 pairs, 15 legal, 34 illegal', () => {
    expect(EVERY_PAIR).toHaveLength(AUTH_FLOW_STATES.length ** 2);
    expect(LEGAL_PAIRS).toHaveLength(15);
    expect(ILLEGAL_PAIRS).toHaveLength(AUTH_FLOW_STATES.length ** 2 - 15);
  });
});

// ---- nothing advances a finished flow -------------------------------------------

describe('a finished flow cannot be advanced', () => {
  const terminalCases: readonly (readonly [string, AuthFlowState])[] = [
    ['completed', AuthFlowState.COMPLETED],
    ['failed', AuthFlowState.FAILED],
    ['expired', AuthFlowState.EXPIRED],
    ['cancelled', AuthFlowState.CANCELLED],
  ];

  it.each(terminalCases)('a %s flow refuses every method that changes state', (_label, state) => {
    const flow = flowIn(state);
    const now = T2;

    expect(() => flow.assertAdvanceable(now)).toThrow(InvalidStateTransitionException);
    expect(() => flow.registerAttempt(now)).toThrow(InvalidStateTransitionException);
    expect(() => flow.requireSecondFactor(now)).toThrow(InvalidStateTransitionException);
    expect(() => flow.requireStepUp(now)).toThrow(InvalidStateTransitionException);
    expect(() => flow.complete(now)).toThrow(InvalidStateTransitionException);
    expect(() => flow.fail('again', now)).toThrow(InvalidStateTransitionException);
    expect(() => flow.cancel('again', now)).toThrow(InvalidStateTransitionException);
    expect(() => flow.expire(now)).toThrow(InvalidStateTransitionException);
  });

  it.each(terminalCases)('a %s flow is terminal', (_label, state) => {
    expect(flowIn(state).isTerminal).toBe(true);
  });

  it('a completed flow cannot be walked back to awaiting_2fa', () => {
    const flow = flowIn(AuthFlowState.COMPLETED);
    expect(() => flow.requireSecondFactor(T2)).toThrow(InvalidStateTransitionException);
    expect(flow.state).toBe(AuthFlowState.COMPLETED);
  });

  it('cancelling twice is refused rather than silently repeated', () => {
    const flow = flowIn(AuthFlowState.CANCELLED);
    expect(() => flow.cancel('again', T2)).toThrow(InvalidStateTransitionException);
    // One `cancelled` step, not two: a redelivered cancel must not re-announce the fact.
    expect(flow.steps.filter((step) => step.to === AuthFlowState.CANCELLED)).toHaveLength(1);
  });
});

// ---- expiry ---------------------------------------------------------------------

describe('expiry', () => {
  it('is not yet expired one millisecond before the TTL', () => {
    const flow = openFlow();
    expect(flow.isExpiredAt(new Date(T0.getTime() + TTL - 1))).toBe(false);
  });

  it('is expired at exactly the TTL', () => {
    const flow = openFlow();
    expect(flow.isExpiredAt(new Date(T0.getTime() + TTL))).toBe(true);
  });

  it('refuses to advance once the TTL has passed', () => {
    const flow = openFlow();
    const later = new Date(T0.getTime() + TTL + 1);

    expect(() => flow.assertAdvanceable(later)).toThrow(InvalidStateTransitionException);
    expect(() => flow.complete(later)).toThrow(InvalidStateTransitionException);
    expect(() => flow.requireSecondFactor(later)).toThrow(InvalidStateTransitionException);
    expect(flow.state).toBe(AuthFlowState.AWAITING_CREDENTIAL);
  });

  it('refuses to advance once it has already been retired', () => {
    const flow = openFlow();
    const later = new Date(T0.getTime() + TTL + 1);

    expect(flow.expireIfDue(later)).toBe(true);
    expect(flow.state).toBe(AuthFlowState.EXPIRED);

    expect(() => flow.assertAdvanceable(later)).toThrow(InvalidStateTransitionException);
    expect(() => flow.complete(later)).toThrow(InvalidStateTransitionException);
  });

  it('does nothing when the TTL has not passed', () => {
    const flow = openFlow();
    expect(flow.expireIfDue(T1)).toBe(false);
    expect(flow.state).toBe(AuthFlowState.AWAITING_CREDENTIAL);
  });

  it('does not re-retire a finished flow', () => {
    const flow = flowIn(AuthFlowState.COMPLETED);
    expect(flow.expireIfDue(new Date(T0.getTime() + TTL * 10))).toBe(false);
    expect(flow.state).toBe(AuthFlowState.COMPLETED);
  });

  it('records the expiry as a step and an event', () => {
    const flow = openFlow();
    flow.clearDomainEvents();

    flow.expire(new Date(T0.getTime() + TTL + 1));
    const events = flow.clearDomainEvents();

    expect(describeSteps(flow.steps)).toContain('awaiting_credential -> expired (expired)');
    expect(events.map((event) => event.eventType)).toEqual([
      'auth_flow.step_completed',
      'auth_flow.failed',
    ]);
  });
});

// ---- the audit trail -------------------------------------------------------------

describe('the step list', () => {
  it('opens with a `started` row that has no predecessor', () => {
    const flow = openFlow();
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]).toMatchObject({
      step: FlowStep.STARTED,
      from: FLOW_ORIGIN,
      to: AuthFlowState.AWAITING_CREDENTIAL,
    });
  });

  it('records every state the flow passed through, oldest first', () => {
    const flow = openFlow();
    flow.requireSecondFactor(T1);
    flow.complete(T2);

    expect(describeSteps(flow.steps)).toEqual([
      'created -> awaiting_credential (started)',
      'awaiting_credential -> awaiting_2fa (credential_verified)',
      'awaiting_2fa -> completed (completed)',
    ]);
  });

  it('records the step-up pause and the proof that ended it', () => {
    const flow = openFlow();
    flow.requireStepUp(T1);
    flow.complete(T2);

    expect(describeSteps(flow.steps)).toEqual([
      'created -> awaiting_credential (started)',
      'awaiting_credential -> awaiting_step_up (step_up_requested)',
      'awaiting_step_up -> completed (completed)',
    ]);
  });

  it('adds no step for a transition that was refused', () => {
    const flow = flowIn(AuthFlowState.COMPLETED);
    const before = flow.steps.length;

    expect(() => flow.requireSecondFactor(T2)).toThrow(InvalidStateTransitionException);
    expect(flow.steps).toHaveLength(before);
  });
});

// ---- attempts -------------------------------------------------------------------

describe('the attempt budget', () => {
  it('counts one use without changing the state', () => {
    const flow = openFlow({ maxAttempts: 3 });
    flow.registerAttempt(T1);

    expect(flow.attemptCount).toBe(1);
    expect(flow.state).toBe(AuthFlowState.AWAITING_CREDENTIAL);
  });

  it('fails the flow when the budget is spent', () => {
    const flow = openFlow({ maxAttempts: 2 });
    flow.registerAttempt(T1);
    flow.registerAttempt(T2);
    flow.registerAttempt(new Date(T2.getTime() + 1));

    expect(flow.state).toBe(AuthFlowState.FAILED);
    expect(flow.failureReason).toBe(MAX_ATTEMPTS_REASON);
  });

  it('refuses to count an attempt against a finished flow', () => {
    const flow = flowIn(AuthFlowState.COMPLETED);
    expect(() => flow.registerAttempt(T2)).toThrow(InvalidStateTransitionException);
    expect(flow.attemptCount).toBe(0);
  });
});

// ---- flow types -----------------------------------------------------------------

describe('flow types', () => {
  it.each([
    [AuthFlowType.LOGIN, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowType.REGISTER, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowType.RESET_PASSWORD, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowType.MAGIC_LINK, AuthFlowState.AWAITING_CREDENTIAL],
    [AuthFlowType.STEP_UP, AuthFlowState.AWAITING_STEP_UP],
  ] as const)('%s opens in %s', (type, state) => {
    const flow = AuthFlow.start({
      flow: type as AuthFlowType,
      userId: USER_ID,
      ttlMs: FLOW_TTL_MS,
      now: T0,
    });
    expect(flow.state).toBe(state);
  });

  it.each([
    [AuthFlowType.LOGIN, true],
    [AuthFlowType.MAGIC_LINK, true],
    [AuthFlowType.REGISTER, false],
    [AuthFlowType.RESET_PASSWORD, false],
    [AuthFlowType.STEP_UP, false],
  ] as const)('%s earns a session: %s', (type, expected) => {
    expect(openFlow({ flow: type as AuthFlowType }).issuesSession).toBe(expected);
  });

  it('refuses an unknown flow type', () => {
    expect(() =>
      AuthFlow.start({
        flow: 'telepathy' as AuthFlowType,
        ttlMs: FLOW_TTL_MS,
        now: T0,
      }),
    ).toThrow('unknown auth flow type');
  });
});

// ---- events ---------------------------------------------------------------------

describe('events', () => {
  it('announces the opening and every step after it', () => {
    const flow = openFlow();
    flow.requireSecondFactor(T1);
    flow.complete(T2);

    expect(flow.clearDomainEvents().map((event) => event.eventType)).toEqual([
      'auth_flow.started',
      'auth_flow.step_completed',
      'auth_flow.step_completed',
      'auth_flow.completed',
    ]);
  });

  it('never carries a credential or a token in a payload', () => {
    const flow = openFlow({ clientIp: '203.0.113.7', userAgent: 'jest' });
    flow.requireSecondFactor(T1);
    flow.complete(T2);

    const serialised = JSON.stringify(
      flow.clearDomainEvents().map((event) => (event as unknown as { payload: unknown }).payload),
    );

    expect(serialised).not.toContain('correct horse');
    expect(serialised).not.toContain('accessToken');
    expect(serialised).not.toContain('refreshToken');
    expect(serialised).toContain(flow.id.value);
  });

  it('reports `failed` and `cancelled` on the one terminal topic', () => {
    const failed = openFlow();
    failed.fail('invalid_credentials', T1);

    const cancelled = openFlow();
    cancelled.cancel('walked away', T1);

    const ended = [...failed.clearDomainEvents(), ...cancelled.clearDomainEvents()].map(
      (event) => [
        event.eventType,
        (event as unknown as { payload: { state: string } }).payload.state,
      ],
    );

    expect(ended).toEqual([
      ['auth_flow.started', 'awaiting_credential'],
      ['auth_flow.step_completed', 'failed'],
      ['auth_flow.failed', 'failed'],
      ['auth_flow.started', 'awaiting_credential'],
      ['auth_flow.step_completed', 'cancelled'],
      ['auth_flow.failed', 'cancelled'],
    ]);
  });
});

// ---- rehydration ----------------------------------------------------------------

describe('rehydration', () => {
  it('round-trips through the row shape', () => {
    const flow = openFlow({ deviceId: 'device-1', clientIp: '203.0.113.7' });
    flow.requireSecondFactor(T1);
    flow.complete(T2);

    const reloaded = AuthFlow.fromRow(flowRowOf(flow));

    expect(reloaded.id.value).toBe(flow.id.value);
    expect(reloaded.state).toBe(AuthFlowState.COMPLETED);
    expect(reloaded.version).toBe(flow.version);
    expect(reloaded.completedAt).toEqual(T2);
    expect(reloaded.deviceId).toBe('device-1');
    expect(reloaded.clientIp).toBe('203.0.113.7');
    expect(reloaded.steps).toHaveLength(flow.steps.length);
    expect(reloaded.clearDomainEvents()).toHaveLength(0);
  });

  it('re-reads the opening row as `created` rather than a state', () => {
    const reloaded = AuthFlow.fromRow(flowRowOf(openFlow()));

    expect(reloaded.steps[0].from).toBe(FLOW_ORIGIN);
  });
});
