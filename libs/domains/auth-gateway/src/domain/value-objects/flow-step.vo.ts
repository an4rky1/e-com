/**
 * @fileoverview The audit trail of a flow: which step ran, and where it moved the flow.
 *
 * @remarks A string union rather than a TypeScript `enum`, like every other enumerated value
 * in this service — the audit rows are read by queries, not by code that imports a symbol.
 *
 * @remarks {@link FlowStepEntry} is the record, and it is deliberately separate from the step
 * *name*. A step name alone cannot answer "how did this flow get here", which is the only
 * question an audit of an authentication flow is ever asked; keeping the pair together in one
 * value object is what makes the answer a projection rather than a reconstruction.
 */
import type { AuthFlowState } from './auth-flow-state.vo';

export const FlowStep = {
  /** The row that records the flow being opened. Not a transition. */
  STARTED: 'started',
  /** A secret was presented and accepted well enough to move the flow on. */
  CREDENTIAL_VERIFIED: 'credential_verified',
  /** The second factor was presented and accepted. */
  TWO_FACTOR_VERIFIED: 'two_factor_verified',
  /** A sensitive action demanded a factor be re-proved; the flow is now waiting on it. */
  STEP_UP_REQUESTED: 'step_up_requested',
  /** The factor a sensitive action demanded was re-proved. */
  STEP_UP_VERIFIED: 'step_up_verified',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const;

export type FlowStep = (typeof FlowStep)[keyof typeof FlowStep];

export const FLOW_STEPS: readonly FlowStep[] = Object.values(FlowStep);

/**
 * `from_status` for the first row.
 *
 * @remarks The column is `NOT NULL`, but a flow that has just been created has not moved
 * anywhere. Rather than inventing a pseudo-state like `'initial'` — which would sit in a column
 * typed `text` and quietly break every consumer that assumes the value is a real
 * {@link AuthFlowState} — the first row says plainly that there was no previous state.
 */
export const FLOW_ORIGIN = 'created' as const;

export type FlowOrigin = typeof FLOW_ORIGIN;

/** Either a state the flow was in, or {@link FLOW_ORIGIN} for the opening row. */
export type FlowStepFrom = AuthFlowState | FlowOrigin;

export interface FlowStepEntry {
  readonly step: FlowStep;
  readonly from: FlowStepFrom;
  readonly to: AuthFlowState;
  readonly occurredAt: Date;
}

/** Builds one audit row. Immutable, so the recorded history cannot be edited in place. */
export function recordStep(
  step: FlowStep,
  from: FlowStepFrom,
  to: AuthFlowState,
  occurredAt: Date,
): FlowStepEntry {
  return { step, from, to, occurredAt };
}

/**
 * The history as one line each, oldest first.
 *
 * @remarks Used by test failure messages and by operators reading a log line; the shape
 * `awaiting_credential -> awaiting_2fa (credential_verified)` is chosen so a diff between two
 * runs of a flow is readable without the table beside it.
 */
export function describeSteps(steps: readonly FlowStepEntry[]): readonly string[] {
  return steps.map((entry) => `${entry.from} -> ${entry.to} (${entry.step})`);
}

/** True when the step proves a factor was presented and accepted. */
export function isProofStep(step: FlowStep): boolean {
  return (
    step === FlowStep.CREDENTIAL_VERIFIED ||
    step === FlowStep.TWO_FACTOR_VERIFIED ||
    step === FlowStep.STEP_UP_VERIFIED
  );
}