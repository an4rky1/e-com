/**
 * @fileoverview The one translation from "what a caller sent" to "what the domain needs".
 *
 * @remarks Split out of the command and query files because both need it. The command path
 * records an attempt, the query path scores one that has not happened yet, and the two must
 * agree on what a device is and where somebody is — two copies of "which country was this
 * account last in" is two answers to one question, and the copy that drifts is the one that
 * decides whether someone gets a second factor.
 */
import type {
  RiskAssessment,
  RiskAssessmentInput,
} from '../../domain/services/risk-scoring.service';
import {
  DeviceFingerprint,
  type DeviceSignals,
} from '../../domain/value-objects/device-fingerprint.vo';
import type { FailureCounters } from '../../domain/value-objects/failure-counters.vo';
import { GeoLocation } from '../../domain/value-objects/geo-location.vo';
import type { LoginAttemptInput } from '../commands/login-attempt.commands';
import type { RiskAssessmentReadModel } from './account-security.queries';

/** Everything the scorer needs, gathered. */
export interface RiskContext {
  readonly fingerprint: DeviceFingerprint;
  readonly knownDevice: boolean;
  readonly location: GeoLocation | null;
  readonly previousLocation: GeoLocation | null;
  readonly counters: FailureCounters;
  readonly usualHours: readonly number[];
  readonly now: Date;
}

/**
 * Turns the caller's optional numbers into a location.
 *
 * @remarks `null` when *either* coordinate is missing, rather than defaulting one and leaving
 * the other. A location with a latitude and no longitude is not a place, and treating it as one
 * puts every login from a proxy that only reports a country at a fixed point on the map.
 */
export function toLocation(input: LoginAttemptInput): GeoLocation | null {
  const { latitude, longitude } = input;
  if (latitude === null || latitude === undefined) return null;
  if (longitude === null || longitude === undefined) return null;

  return GeoLocation.of(latitude, longitude, input.country ?? null);
}

/**
 * The fingerprint to score a login under.
 *
 * @remarks A caller-supplied fingerprint wins over locally computed signals. auth-flow is the
 * edge that sees the real request and computes the same canonical digest we would; taking its
 * word keeps "known device" answering the same question on both sides of the boundary instead of
 * comparing a digest against one that was derived differently.
 *
 * @remarks With neither supplied, the digest is taken over an empty signal set. That is a
 * *constant* fingerprint, so every such request looks like the same device — which is the safe
 * direction: it merges into one bucket rather than minting a fresh "new device" for every
 * caller that omits the header.
 */
export function toFingerprint(input: LoginAttemptInput): DeviceFingerprint {
  const supplied = input.deviceFingerprint?.trim();
  if (supplied) return DeviceFingerprint.fromValue(supplied);

  const signals: DeviceSignals = input.device ?? { userAgent: input.userAgent ?? null };
  return DeviceFingerprint.compute(signals);
}

/**
 * Assembles the scorer's input from raw reads.
 *
 * @remarks `hourOfDay` comes from `now` and nowhere else, and in UTC. A local hour would make
 * the same login score differently depending on which pod answered it, and the "unusual hour"
 * factor would stop meaning anything at all in a fleet spread across three continents.
 */
export function toRiskAssessmentInput(context: RiskContext): RiskAssessmentInput {
  return {
    fingerprint: context.fingerprint,
    knownDevice: context.knownDevice,
    location: context.location,
    previousLocation: context.previousLocation,
    failedAttempts: context.counters.userFailures,
    ipFailureCount: context.counters.ipFailures,
    hourOfDay: context.now.getUTCHours(),
    usualHours: context.usualHours,
  };
}

/**
 * Narrows an assessment to the four fields a caller is allowed to see.
 *
 * @remarks The weights, the thresholds and the policy object stay inside the service. A caller
 * gets a score, a band, the factors it was made of and what to do — not the arithmetic, which
 * is a tuning decision and would be a contract every future weight change breaks.
 */
export function toRiskAssessmentReadModel(assessment: RiskAssessment): RiskAssessmentReadModel {
  return {
    score: assessment.score.value,
    level: assessment.score.level,
    factors: assessment.factors.map((factor) => factor.factor),
    recommendations: [...assessment.recommendations],
  };
}