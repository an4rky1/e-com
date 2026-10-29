/**
 * @fileoverview The auth-flow state machine: every state, and every legal transition.
 *
 * @remarks A string union rather than a TypeScript `enum`, for the same reason identity's
 * `UserStatus` is one: the enum emits runtime code and forces consumers to import the module,
 * and the wire format is plain text. `auth_flows.status` is a `text` column, so adding a state
 * is not a migration.
 *
 * @remarks The transition table is the service's whole reason to exist, so it is *data*
 * (`AUTH_FLOW_TRANSITIONS`) rather than a `switch` buried in a method. One table is one place
 * to read the machine, one place to exhaustively test it, and no way for a new state to be
 * added without someone deciding which predecessors it may follow.
 *
 * @remarks `assertTransition` raises `InvalidStateTransitionException` — a platform type
 * rather than a `DomainError` — deliberately, and against the usual rule for this codebase.
 * Refusing an illegal transition *is* this service's contract: every caller of the gateway
 * (gRPC, REST, the tests) has to recognise the refusal by its type, and a second exception
 * hierarchy reached from two different layers would mean two things to catch.
 */
import { InvalidStateTransitionException } from '@auth/platform/error-handling';

export const AuthFlowState = {
  AWAITING_CREDENTIAL: 'awaiting_credential',
  AWAITING_2FA: 'awaiting_2fa',
  AWAITING_STEP_UP: 'awaiting_step_up',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const;

export type AuthFlowState = (typeof AuthFlowState)[keyof typeof AuthFlowState];

export const AUTH_FLOW_STATES: readonly AuthFlowState[] = Object.values(AuthFlowState);

/**
 * States a flow can never leave.
 *
 * @remarks Every one of them is also absent from its own row in {@link AUTH_FLOW_TRANSITIONS},
 * so the two never disagree: an out-of-date entry here would be a bug, not a second source of
 * truth.
 */
export const TERMINAL_STATES: ReadonlySet<AuthFlowState> = new Set([
  AuthFlowState.COMPLETED,
  AuthFlowState.FAILED,
  AuthFlowState.EXPIRED,
  AuthFlowState.CANCELLED,
]);

/** States a flow can wait in. Exactly the states a caller may advance. */
export const OPEN_STATES: readonly AuthFlowState[] = [
  AuthFlowState.AWAITING_CREDENTIAL,
  AuthFlowState.AWAITING_2FA,
  AuthFlowState.AWAITING_STEP_UP,
];

/**
 * The legal edges, `from -> to`.
 *
 * @remarks The shape of the machine, in one declaration:
 *
 * - `awaiting_credential` may reach every other state: it is where every flow that needs a
 *   secret starts, so it can be satisfied, escalated, refused, timed out or abandoned.
 * - `awaiting_2fa` may reach `awaiting_step_up` — a second factor is proof, not the last word,
 *   and a sensitive action can still demand another.
 * - `awaiting_step_up` completes. It cannot go back to `awaiting_2fa`: a step-up that could be
 *   satisfied by the weaker factor it just proved would not be a step-up at all.
 * - The four terminal states have no outgoing edge, which is what makes "a completed flow
 *   cannot be re-opened" a property of the table rather than of a guard someone can forget.
 *
 * @remarks Note that no row contains its own state. `completed -> completed` is illegal: a
 * replayed request must be *refused*, because silently accepting it would make a redelivery
 * indistinguishable from a fresh submission.
 */
export const AUTH_FLOW_TRANSITIONS: Readonly<
  Record<AuthFlowState, readonly AuthFlowState[]>
> = {
  [AuthFlowState.AWAITING_CREDENTIAL]: [
    AuthFlowState.AWAITING_2FA,
    AuthFlowState.AWAITING_STEP_UP,
    AuthFlowState.COMPLETED,
    AuthFlowState.FAILED,
    AuthFlowState.EXPIRED,
    AuthFlowState.CANCELLED,
  ],
  [AuthFlowState.AWAITING_2FA]: [
    AuthFlowState.AWAITING_STEP_UP,
    AuthFlowState.COMPLETED,
    AuthFlowState.FAILED,
    AuthFlowState.EXPIRED,
    AuthFlowState.CANCELLED,
  ],
  [AuthFlowState.AWAITING_STEP_UP]: [
    AuthFlowState.COMPLETED,
    AuthFlowState.FAILED,
    AuthFlowState.EXPIRED,
    AuthFlowState.CANCELLED,
  ],
  [AuthFlowState.COMPLETED]: [],
  [AuthFlowState.FAILED]: [],
  [AuthFlowState.EXPIRED]: [],
  [AuthFlowState.CANCELLED]: [],
};

export function isAuthFlowState(value: unknown): value is AuthFlowState {
  return (
    typeof value === 'string' && (AUTH_FLOW_STATES as string[]).includes(value)
  );
}

export function isTerminalState(state: AuthFlowState): boolean {
  return TERMINAL_STATES.has(state);
}

/** The states `from` may legally move to. */
export function allowedTargets(from: AuthFlowState): readonly AuthFlowState[] {
  return AUTH_FLOW_TRANSITIONS[from];
}

export function canTransition(from: AuthFlowState, to: AuthFlowState): boolean {
  return AUTH_FLOW_TRANSITIONS[from].includes(to);
}

/**
 * The one gate every state change passes through.
 *
 * @throws InvalidStateTransitionException with `from`, `to` and the allowed targets in its
 * context, so a caller can report the machine's own rules without this module having to
 * re-describe them.
 */
export function assertTransition(
  from: AuthFlowState,
  to: AuthFlowState,
  context: Record<string, unknown> = {},
): void {
  if (canTransition(from, to)) return;

  const terminal = isTerminalState(from);
  throw new InvalidStateTransitionException(
    terminal
      ? `auth flow is ${from} and cannot be advanced`
      : `cannot move an auth flow from ${from} to ${to}`,
    {
      from,
      to,
      allowed: [...AUTH_FLOW_TRANSITIONS[from]],
      ...context,
    },
  );
}

/** A human-readable list of the legal edges — used in JSDoc, logs and test failure text. */
export function describeTransitionTable(): readonly string[] {
  return AUTH_FLOW_STATES.flatMap((from) =>
    AUTH_FLOW_TRANSITIONS[from].map((to) => `${from} -> ${to}`),
  );
}