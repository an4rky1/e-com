/**
 * @fileoverview The risk model's entry point, as a port.
 *
 * @remarks `RiskScoringService` is a plain class in `domain/services`, but the application layer
 * resolves it from the container rather than constructing it, for the same reason it resolves
 * the repository: a test should be able to swap the model without touching a handler, and a
 * threshold change should be a configuration change rather than a constructor call at four
 * different sites.
 */
import type { RiskAssessment, RiskAssessmentInput } from '../services/risk-scoring.service';

export const RISK_SCORING = Symbol('RISK_SCORING');

export interface RiskScoringPort {
  assess(input: RiskAssessmentInput): RiskAssessment;
}