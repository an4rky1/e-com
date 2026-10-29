/**
 * @fileoverview The risk model: weighted factors in, one score and one band out.
 *
 * @remarks This is the only place in the service that decides what "suspicious" means, and it is
 * a pure function of its input. Nothing here performs I/O, reads a clock, or reaches a store —
 * every threshold arrives in the constructor. That is what makes the security thresholds
 * testable as a table instead of as an integration test that needs a database and a Redis to
 * observe a number.
 *
 * @remarks It *signals*; it never blocks. The service deliberately returns a recommendation
 * string and not a decision: a false positive here locks a real person out of their account,
 * and the entity that has the whole picture — auth-flow, which can ask for a second factor
 * instead of refusing — is the one that refuses. Everything in this file is therefore evidence,
 * and the weights are a statement of suspicion rather than an enforcement policy.
 */
import {
  RISK_BOUNDARIES,
  RiskLevel,
  RiskScore,
  riskCeilingFor,
} from '../value-objects/risk-score.vo';
import { DEFAULT_IMPOSSIBLE_TRAVEL_KM } from '../value-objects/geo-location.vo';
import type { GeoLocation } from '../value-objects/geo-location.vo';
import type { DeviceFingerprint } from '../value-objects/device-fingerprint.vo';

/**
 * The factors the model weighs.
 *
 * @remarks An `as const` union rather than a TypeScript `enum`: factor names are published in
 * `SecurityEventPayload.factors` and in the gRPC `factors` field, so they are wire values that
 * a consumer in another language has to be able to spell without importing anything from here.
 */
export const RiskFactorType = {
  /** A fingerprint this account has never used before. */
  NEW_DEVICE: 'new_device',
  /** Sign-in hours that are rare for this account. */
  UNUSUAL_HOUR: 'unusual_hour',
  /** A country the account has not signed in from before. */
  NEW_COUNTRY: 'new_country',
  /** Travel faster than physics allows from the last known location. */
  UNUSUAL_LOCATION: 'unusual_location',
  /** Several failures inside the scoring window. */
  RAPID_FAILED_ATTEMPTS: 'rapid_failed_attempts',
  /** The ip has been failing regardless of which account it targets. */
  IP_FAILURE_BURST: 'ip_failure_burst',
} as const;

export type RiskFactorType = (typeof RiskFactorType)[keyof typeof RiskFactorType];

/**
 * How many points each factor is worth.
 *
 * @remarks Weights, not percentages, because the factors are independent triggers and a run of
 * all six is legitimately more suspicious than any one of them. They sum above 100 (135), which
 * is intentional and is why {@link RiskScore.create} clamps: a login that trips everything is
 * at the top of the scale, not off it.
 *
 * @remarks The ordering is the argument. `unusual_location` (30) and `rapid_failed_attempts`
 * (35) outrank `new_device` (25), because a new browser is an everyday event and impossible
 * travel during a credential run is not. `unusual_hour` is the weakest at 10 for the same
 * reason — plenty of people work nights — which is why crossing into `medium` on a 3am sign-in
 * is impossible on its own.
 */
export const RISK_FACTOR_WEIGHTS: Readonly<Record<RiskFactorType, number>> = {
  [RiskFactorType.UNUSUAL_LOCATION]: 30,
  [RiskFactorType.RAPID_FAILED_ATTEMPTS]: 35,
  [RiskFactorType.NEW_DEVICE]: 25,
  [RiskFactorType.IP_FAILURE_BURST]: 20,
  [RiskFactorType.NEW_COUNTRY]: 15,
  [RiskFactorType.UNUSUAL_HOUR]: 10,
};

/** Thresholds and windows the model is tuned with. Overridable, never read from the environment here. */
export interface RiskScoringPolicy {
  /** Failures by *this user* inside the window at which a run is assumed. */
  rapidFailureThreshold: number;
  /** Failures by *this ip* inside the window at which a distributed run is assumed. */
  ipFailureThreshold: number;
  /** Kilometres of travel beyond which two logins are too far apart. */
  impossibleTravelKm: number;
  /** Inclusive start of the hours treated as unusual, UTC. */
  unusualHourFrom: number;
  /** Exclusive end of the hours treated as unusual, UTC. */
  unusualHourTo: number;
  /** Hours of this user's own history used to decide which hours are unusual. */
  usualHourSampleSize: number;
  /** Score at or above which the login is `high` and gets a second factor. */
  stepUpAt: number;
  /** Score at or above which the user is told. */
  notifyAt: number;
  /** Score at or above which the caller is told to refuse the login outright. */
  refuseAt: number;
}

export const Defaults = {
  /**
   * Three failures inside five minutes.
   *
   * @remarks Two is a typo. Five is above the "fat-fingered user retypes their password" run
   * and below the window in which a scripted guessing pass is worth anything.
   */
  RAPID_FAILURE_THRESHOLD: 3,
  /**
   * Ten failures from one ip inside the same window.
   *
   * @remarks Higher than the per-user threshold by design. A single ip failing against many
   * accounts is credential stuffing, and it must be distinguishable from one person mistyping:
   * a lock at the same threshold would let one attacker lock out every account in the system
   * by failing three times each.
   */
  IP_FAILURE_THRESHOLD: 10,
  IMPOSSIBLE_TRAVEL_KM: DEFAULT_IMPOSSIBLE_TRAVEL_KM,
  /** 01:00-05:00 UTC. Short, and deliberately not "night" everywhere. */
  UNUSUAL_HOUR_FROM: 1,
  UNUSUAL_HOUR_TO: 5,
  USUAL_HOUR_SAMPLE_SIZE: 20,
  STEP_UP_AT: 50,
  NOTIFY_AT: 75,
  REFUSE_AT: 90,
} as const;

/** One factor that fired, and what it was worth. */
export interface RiskFactor {
  readonly factor: RiskFactorType;
  readonly weight: number;
}

/** Everything the scorer was told, and everything it concluded. */
export interface RiskAssessment {
  readonly score: RiskScore;
  readonly factors: readonly RiskFactor[];
  /** `true` once the login is at or above `notifyAt`. Consumers treat this as "tell someone". */
  readonly suspicious: boolean;
  readonly recommendations: readonly string[];
}

/** The login being scored. Plain data, so the model never sees an aggregate. */
export interface RiskAssessmentInput {
  readonly fingerprint: DeviceFingerprint;
  /** Whether this account has used this fingerprint before. */
  readonly knownDevice: boolean;
  /** Where this login claims to be from, when the edge could tell us. */
  readonly location: GeoLocation | null;
  /** Where the account was last seen, if anywhere. */
  readonly previousLocation: GeoLocation | null;
  /** Failures by this user inside the scoring window. */
  readonly failedAttempts: number;
  /**
   * Consecutive failures from this ip, regardless of which account was targeted.
   *
   * @remarks The counter is per *ip*, not per user, because credential stuffing is the attack
   * this catches and it does not care whose account it is trying — a per-user counter would be
   * zero for every account the attacker has not reached yet.
   */
  readonly ipFailureCount: number;
  /** UTC hour of this login, 0-23. */
  readonly hourOfDay: number;
  /**
   * UTC hours this account usually signs in at.
   *
   * @remarks An empty history is the normal case for a new account and must not itself be a
   * factor; the first sign-in of every user would otherwise be "unusual".
   */
  readonly usualHours: readonly number[];
}

export class RiskScoringService {
  constructor(private readonly policy: RiskScoringPolicy = RiskScoringService.standard()) {}

  /**
   * The defaults above, in the policy's own shape.
   *
   * @remarks Written out rather than spread, because `Defaults` is also read by the module
   * factory where it arrives as `ACCOUNT_SECURITY_*` environment variables — and a rename on
   * one side that does not happen on the other would be a silently different threshold in
   * production than the one the docs describe.
   */
  static standard(): RiskScoringPolicy {
    return {
      rapidFailureThreshold: Defaults.RAPID_FAILURE_THRESHOLD,
      ipFailureThreshold: Defaults.IP_FAILURE_THRESHOLD,
      impossibleTravelKm: Defaults.IMPOSSIBLE_TRAVEL_KM,
      unusualHourFrom: Defaults.UNUSUAL_HOUR_FROM,
      unusualHourTo: Defaults.UNUSUAL_HOUR_TO,
      usualHourSampleSize: Defaults.USUAL_HOUR_SAMPLE_SIZE,
      stepUpAt: Defaults.STEP_UP_AT,
      notifyAt: Defaults.NOTIFY_AT,
      refuseAt: Defaults.REFUSE_AT,
    };
  }

  /** The defaults with named overrides, so a test can move one threshold without the rest. */
  static of(overrides: Partial<RiskScoringPolicy> = {}): RiskScoringPolicy {
    return { ...RiskScoringService.standard(), ...overrides };
  }

  /**
   * Scores one login.
   *
   * @remarks The factors are evaluated and summed, then clamped once by {@link RiskScore.create}.
   * Nothing here returns early: a login can be a new device *and* impossibly far away, and
   * stopping at the first hit would throw away the information a human reviewing the signal
   * actually wants.
   */
  assess(input: RiskAssessmentInput): RiskAssessment {
    const fired: RiskFactor[] = [];

    const record = (factor: RiskFactorType): void => {
      fired.push({ factor, weight: RISK_FACTOR_WEIGHTS[factor] });
    };

    if (!input.knownDevice) record(RiskFactorType.NEW_DEVICE);

    if (this.isUnusualLocation(input)) record(RiskFactorType.UNUSUAL_LOCATION);

    if (this.isNewCountry(input)) record(RiskFactorType.NEW_COUNTRY);

    if (input.failedAttempts >= this.policy.rapidFailureThreshold) {
      record(RiskFactorType.RAPID_FAILED_ATTEMPTS);
    }

    // The *consecutive* ip counter, not the in-window one: this is the factor that catches an
    // attacker who spaces attempts out to stay under the window.
    if (input.ipFailureCount >= this.policy.ipFailureThreshold) {
      record(RiskFactorType.IP_FAILURE_BURST);
    }

    if (this.isUnusualHour(input)) record(RiskFactorType.UNUSUAL_HOUR);

    const total = fired.reduce((sum, factor) => sum + factor.weight, 0);
    const score = RiskScore.create(total);

    return {
      score,
      factors: fired,
      suspicious: score.value >= this.policy.notifyAt,
      recommendations: this.recommend(score, fired),
    };
  }

  /**
   * Two logins too far apart to be the same person travelling.
   *
   * @remarks With no coordinates on either side there is nothing to compare, and the answer is
   * `false`. "The edge could not locate us" is not evidence of travel, and a maximum-distance
   * assumption would make every login behind a proxy with no GeoIP entry look like a hijack.
   */
  private isUnusualLocation(input: RiskAssessmentInput): boolean {
    if (!input.location || !input.previousLocation) return false;
    return input.location.distanceToKm(input.previousLocation) > this.policy.impossibleTravelKm;
  }

  /**
   * A country the account has not been seen in.
   *
   * @remarks Requires *both* sides to name a country. An unknown country is not a new country:
   * an IP database that has never heard of the address would otherwise make the first sign-in
   * from every new region a flagged one.
   */
  private isNewCountry(input: RiskAssessmentInput): boolean {
    const current = input.location?.country ?? null;
    const previous = input.previousLocation?.country ?? null;
    if (current === null || previous === null) return false;
    return current !== previous;
  }

  /**
   * An hour this account does not normally sign in at.
   *
   * @remarks Two independent triggers, either of which is enough. The configured window
   * (01:00-05:00 UTC) catches the obvious case with no history at all; the account's own
   * history catches the user who always signs in at 09:00 and signs in once at 14:00. The
   * history check needs at least one sample, so a brand-new account is judged by the window
   * alone and a 3am sign-in still scores — it just does not score twice.
   */
  private isUnusualHour(input: RiskAssessmentInput): boolean {
    const hour = input.hourOfDay;
    const inWindow = hour >= this.policy.unusualHourFrom && hour < this.policy.unusualHourTo;
    if (inWindow) return true;

    const sample = input.usualHours.slice(0, this.policy.usualHourSampleSize);
    if (sample.length === 0) return false;

    return !sample.includes(hour);
  }

  /**
   * What the caller should do about this login.
   *
   * @remarks Recommendations, not instructions. `refuse` is a recommendation because the
   * decision belongs to auth-flow, which can weigh this against a second factor; emitting an
   * `action` enum here would push the enforcement decision into a service that cannot see the
   * rest of the request.
   */
  private recommend(score: RiskScore, factors: readonly RiskFactor[]): readonly string[] {
    const recommendations: string[] = [];
    const value = score.value;

    if (value >= this.policy.refuseAt) recommendations.push('refuse');
    if (value >= this.policy.stepUpAt) recommendations.push('require_second_factor');
    if (value >= this.policy.notifyAt) recommendations.push('notify_user');

    const has = (factor: RiskFactorType): boolean => factors.some((f) => f.factor === factor);

    if (has(RiskFactorType.NEW_DEVICE)) recommendations.push('prompt_device_confirmation');
    if (has(RiskFactorType.UNUSUAL_LOCATION)) recommendations.push('alert_impossible_travel');
    if (has(RiskFactorType.RAPID_FAILED_ATTEMPTS)) recommendations.push('throttle_failed_logins');
    if (has(RiskFactorType.IP_FAILURE_BURST)) recommendations.push('challenge_source_ip');

    // A `low` login gets an explicit "nothing to do", so a consumer that renders the list does
    // not have to special-case the empty one.
    if (recommendations.length === 0) recommendations.push('allow');

    return recommendations;
  }

  /** The band table, exposed so a caller can render the scale without hardcoding it. */
  static get boundaries(): ReadonlyArray<{
    level: RiskLevel;
    min: number;
    max: number;
  }> {
    const bands: readonly RiskLevel[] = [
      RiskLevel.LOW,
      RiskLevel.MEDIUM,
      RiskLevel.HIGH,
      RiskLevel.CRITICAL,
    ];
    return bands.map((level) => ({
      level,
      min: RISK_BOUNDARIES_BY_LEVEL[level],
      max: riskCeilingFor(level),
    }));
  }
}

/** Inclusive lower bound of each band — the same three numbers `riskLevelFor` compares against. */
const RISK_BOUNDARIES_BY_LEVEL: Readonly<Record<RiskLevel, number>> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: RISK_BOUNDARIES.MEDIUM,
  [RiskLevel.HIGH]: RISK_BOUNDARIES.HIGH,
  [RiskLevel.CRITICAL]: RISK_BOUNDARIES.CRITICAL,
};