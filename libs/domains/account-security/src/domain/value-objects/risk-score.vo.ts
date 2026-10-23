/**
 * @fileoverview The risk score and its bands.
 *
 * @remarks `RiskLevel` is an `as const` union rather than a TypeScript `enum`. The enum emits
 * runtime code and forces every consumer — a gRPC handler, a JSON payload, a Kafka consumer in
 * another service — to import this module to name a value, and the wire format is plain text.
 * A union keeps the string as the single representation: it is what goes into
 * `security_signals.signal_type`, into `SecurityEventPayload.riskLevel`, and into the gRPC
 * `level` field, and none of those can drift from a generated `enum` member.
 */
import { ValueObject } from '@auth/core';

export const RiskLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

/**
 * Where each band starts.
 *
 * @remarks The contract is `low < 25`, `medium < 50`, `high < 75`, `critical >= 75`, i.e. every
 * boundary is *inclusive at the bottom of the higher band*. That is the direction that matters:
 * a score of exactly 25 is `medium`, not `low`. Getting it the other way makes a login one
 * point less risky than the policy says, and the whole reason the numbers are named here
 * rather than inlined in a chain of `<` comparisons is so that the boundary exists in exactly
 * one place.
 */
export const RISK_BOUNDARIES = {
  MEDIUM: 25,
  HIGH: 50,
  CRITICAL: 75,
} as const;

export const RISK_SCORE_MIN = 0;
export const RISK_SCORE_MAX = 100;

/**
 * The band a numeric score falls into.
 *
 * @remarks Exported standalone so the boundary table can be tested without constructing a
 * `RiskScore`, and so `RiskScore.level` has exactly one implementation to call.
 */
export function riskLevelFor(score: number): RiskLevel {
  if (score >= RISK_BOUNDARIES.CRITICAL) return RiskLevel.CRITICAL;
  if (score >= RISK_BOUNDARIES.HIGH) return RiskLevel.HIGH;
  if (score >= RISK_BOUNDARIES.MEDIUM) return RiskLevel.MEDIUM;
  return RiskLevel.LOW;
}

/**
 * The largest score that still lands in `level`.
 *
 * @remarks The upper bound of a band is exclusive, so the answer is the *next* boundary minus
 * one. Exists so an operator can be told "you are 26 points from a step-up" rather than left to
 * work out which comparison in {@link riskLevelFor} produced their answer.
 */
export function riskCeilingFor(level: RiskLevel): number {
  switch (level) {
    case RiskLevel.LOW:
      return RISK_BOUNDARIES.MEDIUM - 1;
    case RiskLevel.MEDIUM:
      return RISK_BOUNDARIES.HIGH - 1;
    case RiskLevel.HIGH:
      return RISK_BOUNDARIES.CRITICAL - 1;
    case RiskLevel.CRITICAL:
      return RISK_SCORE_MAX;
  }
}

export class RiskScore extends ValueObject<{ value: number }> {
  private constructor(value: number) {
    super({ value });
  }

  /**
   * Coerces a weighted total into a 0-100 score.
   *
   * @remarks Clamped rather than rejected. The weights are additive and independent, so a login
   * that trips six factors legitimately totals more than 100, and refusing to score it would
   * make the most dangerous login the one that produces no answer. `NaN` becomes 0 for the
   * same reason as the clamp on the low side: "no evidence" must not read as "maximum risk".
   */
  static create(raw: number): RiskScore {
    if (!Number.isFinite(raw)) return new RiskScore(RISK_SCORE_MIN);
    return new RiskScore(Math.min(RISK_SCORE_MAX, Math.max(RISK_SCORE_MIN, Math.round(raw))));
  }

  /** The zero score, for the "no factors fired" path. */
  static zero(): RiskScore {
    return new RiskScore(RISK_SCORE_MIN);
  }

  get value(): number {
    return this.props.value;
  }

  get level(): RiskLevel {
    return riskLevelFor(this.props.value);
  }

  /** Points short of the next band, or 0 when already `critical`. */
  pointsToNextLevel(): number {
    if (this.level === RiskLevel.CRITICAL) return 0;
    return riskCeilingFor(this.level) - this.props.value + 1;
  }

  override toString(): string {
    return String(this.props.value);
  }
}