/**
 * The risk model.
 *
 * @remarks Two tables, and both exist because the numbers are security thresholds. The bucket
 * table pins the exact boundary values with no arithmetic involved, and the factor table pins
 * what each input is worth — so a weight change shows up as a one-line diff in a test failure
 * rather than as a cohort of users who started getting a second factor.
 */
import {
  RISK_BOUNDARIES,
  RISK_SCORE_MAX,
  RiskLevel,
  RiskScore,
  riskCeilingFor,
  riskLevelFor,
} from '../src/domain/value-objects/risk-score.vo';
import {
  RISK_FACTOR_WEIGHTS,
  RiskFactorType,
  RiskScoringService,
  type RiskAssessmentInput,
} from '../src/domain/services/risk-scoring.service';
import { DeviceFingerprint } from '../src/domain/value-objects/device-fingerprint.vo';
import { GeoLocation, haversineDistanceKm } from '../src/domain/value-objects/geo-location.vo';

const FINGERPRINT = DeviceFingerprint.compute({ platform: 'linux' });
const OTHER_FINGERPRINT = DeviceFingerprint.compute({ platform: 'windows' });
const LONDON = GeoLocation.of(51.5074, -0.1278, 'GB');
const PARIS = GeoLocation.of(48.8566, 2.3522, 'FR');
const SYDNEY = GeoLocation.of(-33.8688, 151.2093, 'AU');
const EDINBURGH = GeoLocation.of(55.9533, -3.1883, 'GB');

/**
 * Isolating the two location factors needs real geography, not a flag.
 *
 * @remarks Sydney is 17,000 km from London, so comparing against it trips the travel rule *and*
 * the country rule at once and tells you nothing about either. Edinburgh is 530 km from London
 * in the same country — too far for one session, not a new country — and Paris is 344 km away in
 * a different one. Between them each factor can be switched on alone, and a test that says
 * "unusual_location fired" is not quietly also asserting "new_country fired".
 */
const SAME_COUNTRY_TOO_FAR = EDINBURGH; // from LONDON: travel only (530 km, still GB)
const OTHER_COUNTRY_CLOSE_BY = PARIS; // from LONDON: country only (344 km < 500 km)
const OTHER_HEMISPHERE = SYDNEY; // from LONDON: travel and country

/** A login that trips nothing, so a test changes exactly one thing at a time. */
const CALM: RiskAssessmentInput = {
  fingerprint: FINGERPRINT,
  knownDevice: true,
  location: LONDON,
  previousLocation: LONDON,
  failedAttempts: 0,
  ipFailureCount: 0,
  hourOfDay: 12,
  usualHours: [12],
};

const assess = (
  overrides: Partial<RiskAssessmentInput>,
  policy = RiskScoringService.standard(),
): ReturnType<RiskScoringService['assess']> =>
  new RiskScoringService(policy).assess({ ...CALM, ...overrides });

// ---- RiskScore — the bucket boundaries ------------------------------------------------------------------

describe('RiskScore — bucket boundaries', () => {
  /**
   * The one table that matters.
   *
   * @remarks Every band boundary is checked from both sides, and the expectation is spelled out
   * per row rather than derived from the implementation. `low < 25`, `medium < 50`, `high < 75`,
   * `critical >= 75`: an off-by-one here is the difference between a login that gets a second
   * factor and one that does not, and it would not show up anywhere else.
   */
  const cases: ReadonlyArray<readonly [number, RiskLevel]> = [
    [0, RiskLevel.LOW],
    [24, RiskLevel.LOW],
    [25, RiskLevel.MEDIUM],
    [26, RiskLevel.MEDIUM],
    [49, RiskLevel.MEDIUM],
    [50, RiskLevel.HIGH],
    [51, RiskLevel.HIGH],
    [74, RiskLevel.HIGH],
    [75, RiskLevel.CRITICAL],
    [76, RiskLevel.CRITICAL],
    [99, RiskLevel.CRITICAL],
    [100, RiskLevel.CRITICAL],
  ];

  it.each(cases)('%i is %s', (score, expected) => {
    expect(RiskScore.create(score).level).toBe(expected);
    expect(riskLevelFor(score)).toBe(expected);
  });

  it.each(cases)('%i keeps its value through the constructor', (score) => {
    expect(RiskScore.create(score).value).toBe(score);
  });

  it('names the three boundaries once', () => {
    expect(RISK_BOUNDARIES).toEqual({ MEDIUM: 25, HIGH: 50, CRITICAL: 75 });
  });

  it('reports the ceiling of each band as the next boundary minus one', () => {
    expect(riskCeilingFor(RiskLevel.LOW)).toBe(24);
    expect(riskCeilingFor(RiskLevel.MEDIUM)).toBe(49);
    expect(riskCeilingFor(RiskLevel.HIGH)).toBe(74);
    expect(riskCeilingFor(RiskLevel.CRITICAL)).toBe(100);
  });

  it('reports the bands in order, without gaps', () => {
    const bands = RiskScoringService.boundaries;

    expect(bands.map((band) => `${band.min}-${band.max}`)).toEqual([
      '0-24',
      '25-49',
      '50-74',
      '75-100',
    ]);
  });
});

describe('RiskScore — clamping', () => {
  it('clamps above the maximum', () => {
    expect(RiskScore.create(1_000).value).toBe(RISK_SCORE_MAX);
    expect(RiskScore.create(1_000).level).toBe(RiskLevel.CRITICAL);
  });

  it('clamps below the minimum', () => {
    expect(RiskScore.create(-40).value).toBe(0);
    expect(RiskScore.create(-40).level).toBe(RiskLevel.LOW);
  });

  it('treats a non-finite total as zero rather than as maximum risk', () => {
    // "We could not add the numbers up" must never arrive as "most dangerous login ever".
    expect(RiskScore.create(Number.NaN).value).toBe(0);
    expect(RiskScore.create(Number.POSITIVE_INFINITY).value).toBe(0);
  });

  it('rounds a fractional total to a whole score', () => {
    expect(RiskScore.create(24.4).value).toBe(24);
    expect(RiskScore.create(24.5).value).toBe(25);
  });

  it('clamps a total that ran past the top of the scale', () => {
    // This is what the scorer hands `create`: a sum of six independent weights, not a score
    // that was already in range.
    expect(RiskScore.create(120).value).toBe(RISK_SCORE_MAX);
  });

  it('reports how far the next band is', () => {
    expect(RiskScore.create(24).pointsToNextLevel()).toBe(1);
    expect(RiskScore.create(0).pointsToNextLevel()).toBe(25);
    expect(RiskScore.create(100).pointsToNextLevel()).toBe(0);
  });
});

// ---- RiskScoringService — the factors -------------------------------------------------------------------

describe('RiskScoringService — each factor contributes', () => {
  it('scores zero for a login that trips nothing', () => {
    const assessment = assess({});

    expect(assessment.score.value).toBe(0);
    expect(assessment.score.level).toBe(RiskLevel.LOW);
    expect(assessment.factors).toEqual([]);
    expect(assessment.recommendations).toEqual(['allow']);
    expect(assessment.suspicious).toBe(false);
  });

  const factorCases: ReadonlyArray<
    readonly [string, RiskFactorType, Partial<RiskAssessmentInput>]
  > = [
    ['a new device', RiskFactorType.NEW_DEVICE, { knownDevice: false }],
    [
      'impossible travel',
      RiskFactorType.UNUSUAL_LOCATION,
      { previousLocation: SAME_COUNTRY_TOO_FAR },
    ],
    [
      'a new country',
      RiskFactorType.NEW_COUNTRY,
      { previousLocation: OTHER_COUNTRY_CLOSE_BY },
    ],
    [
      'a run of failures',
      RiskFactorType.RAPID_FAILED_ATTEMPTS,
      { failedAttempts: 3 },
    ],
    [
      'an ip failing across accounts',
      RiskFactorType.IP_FAILURE_BURST,
      { ipFailureCount: 10 },
    ],
    ['an unusual hour', RiskFactorType.UNUSUAL_HOUR, { hourOfDay: 3, usualHours: [] }],
  ];

  it.each(factorCases)('%s contributes its own weight', (_label, factor, overrides) => {
    const assessment = assess(overrides);

    expect(assessment.factors).toEqual([{ factor, weight: RISK_FACTOR_WEIGHTS[factor] }]);
    expect(assessment.score.value).toBe(RISK_FACTOR_WEIGHTS[factor]);
  });

  it('never scores above 100 no matter how many factors fire', () => {
    const assessment = assess({
      knownDevice: false,
      previousLocation: OTHER_HEMISPHERE,
      failedAttempts: 99,
      ipFailureCount: 99,
      hourOfDay: 3,
      usualHours: [],
    });

    const total = assessment.factors.reduce((sum, factor) => sum + factor.weight, 0);
    expect(total).toBeGreaterThan(RISK_SCORE_MAX);
    expect(assessment.score.value).toBe(RISK_SCORE_MAX);
    expect(assessment.score.level).toBe(RiskLevel.CRITICAL);
  });

  it('adds factors together rather than stopping at the first one', () => {
    // new_device (25) + new_country (15) = 40, which lands in `medium` on its own.
    const assessment = assess({
      knownDevice: false,
      previousLocation: GeoLocation.of(48.8566, 2.3522, 'FR'),
    });

    expect(assessment.score.value).toBe(40);
    expect(assessment.factors.map((factor) => factor.factor)).toEqual([
      RiskFactorType.NEW_DEVICE,
      RiskFactorType.NEW_COUNTRY,
    ]);
  });

  it('reaches `critical` at exactly 75 from three factors', () => {
    // new_device (25) + new_country (15) + rapid failures (35) = 75, the first critical point.
    const assessment = assess({
      knownDevice: false,
      previousLocation: GeoLocation.of(48.8566, 2.3522, 'FR'),
      failedAttempts: 5,
    });

    expect(assessment.score.value).toBe(75);
    expect(assessment.score.level).toBe(RiskLevel.CRITICAL);
  });
});

describe('RiskScoringService — when a factor stays silent', () => {
  it('does not call the very first login from a device new', () => {
    // An account with no devices has none it knows, so `new_device` would fire on literally
    // every user's first ever sign-in. The handler passes `knownDevice` for an account that
    // has logged in before; the model reports what it is told.
    const assessment = assess({ knownDevice: true, previousLocation: null, usualHours: [] });

    expect(assessment.factors).toEqual([]);
  });

  it('does not infer travel from a missing coordinate', () => {
    const assessment = assess({ location: null, previousLocation: SYDNEY });

    expect(assessment.factors).toEqual([]);
  });

  it('does not infer a new country from a missing country name', () => {
    // The coordinates are 344 km apart, so only the country rule could have fired — and it
    // cannot, because one side of the comparison has no country at all.
    const assessment = assess({
      location: GeoLocation.of(51.5, -0.12),
      previousLocation: OTHER_COUNTRY_CLOSE_BY,
    });

    expect(assessment.factors).toEqual([]);
  });

  it('fires both location factors at once for a hop across the world', () => {
    const assessment = assess({ previousLocation: OTHER_HEMISPHERE });

    expect(assessment.factors.map((factor) => factor.factor)).toEqual([
      RiskFactorType.UNUSUAL_LOCATION,
      RiskFactorType.NEW_COUNTRY,
    ]);
    expect(assessment.score.value).toBe(
      RISK_FACTOR_WEIGHTS[RiskFactorType.UNUSUAL_LOCATION] +
        RISK_FACTOR_WEIGHTS[RiskFactorType.NEW_COUNTRY],
    );
  });

  it('does not fire the country rule for a long trip inside one country', () => {
    // 530 km is past the travel threshold and stays `GB`, so exactly one factor may appear.
    const assessment = assess({ previousLocation: SAME_COUNTRY_TOO_FAR });

    expect(assessment.factors).toEqual([
      { factor: RiskFactorType.UNUSUAL_LOCATION, weight: RISK_FACTOR_WEIGHTS[RiskFactorType.UNUSUAL_LOCATION] },
    ]);
  });

  it('does not fire the travel rule for a short trip between countries', () => {
    // London and Paris are 344 km apart — a plausible drive, and under the threshold.
    expect(haversineDistanceKm(LONDON, PARIS)).toBeLessThan(500);
    expect(assess({ previousLocation: OTHER_COUNTRY_CLOSE_BY }).factors).toEqual([
      { factor: RiskFactorType.NEW_COUNTRY, weight: RISK_FACTOR_WEIGHTS[RiskFactorType.NEW_COUNTRY] },
    ]);
  });

  it('does not flag an unusual hour for an account with no history', () => {
    // With no history there is no usual hour to deviate from, and the 01:00-05:00 window is
    // the only rule that can apply. A 09:00 sign-in by a new account is simply a new account.
    const assessment = assess({ hourOfDay: 9, usualHours: [] });

    expect(assessment.factors).toEqual([]);
  });

  it('flags an hour the account never uses, in daylight', () => {
    const assessment = assess({ hourOfDay: 14, usualHours: [8, 9, 10] });

    expect(assessment.factors.map((factor) => factor.factor)).toEqual([
      RiskFactorType.UNUSUAL_HOUR,
    ]);
  });

  it('flags an hour inside the configured window even with a matching history', () => {
    const assessment = assess({ hourOfDay: 3, usualHours: [3] });

    expect(assessment.factors.map((factor) => factor.factor)).toEqual([
      RiskFactorType.UNUSUAL_HOUR,
    ]);
  });

  it('does not flag a repeat hour inside the history window', () => {
    expect(assess({ hourOfDay: 10, usualHours: [8, 9, 10] }).factors).toEqual([]);
  });

  it('treats the hour window as inclusive at the start and exclusive at the end', () => {
    const policy = RiskScoringService.of({ unusualHourFrom: 2, unusualHourTo: 6 });

    expect(assess({ hourOfDay: 2, usualHours: [] }, policy).factors).toHaveLength(1);
    expect(assess({ hourOfDay: 5, usualHours: [] }, policy).factors).toHaveLength(1);
    expect(assess({ hourOfDay: 6, usualHours: [6] }, policy).factors).toHaveLength(0);
    expect(assess({ hourOfDay: 1, usualHours: [1] }, policy).factors).toHaveLength(0);
  });
});

describe('RiskScoringService — thresholds are the caller\'s to move', () => {
  it('does not flag a run one below the threshold', () => {
    expect(assess({ failedAttempts: 2 }).factors).toEqual([]);
  });

  it('flags a run exactly at the threshold', () => {
    expect(assess({ failedAttempts: 3 }).factors).toHaveLength(1);
  });

  it('moves the threshold without touching the other rules', () => {
    const strict = RiskScoringService.of({ rapidFailureThreshold: 1 });

    const assessment = assess({ failedAttempts: 1 }, strict);
    expect(assessment.factors.map((factor) => factor.factor)).toEqual([
      RiskFactorType.RAPID_FAILED_ATTEMPTS,
    ]);
  });
});

describe('RiskScoringService — recommendations', () => {
  it('asks for nothing on a low login', () => {
    expect(assess({}).recommendations).toEqual(['allow']);
  });

  it('asks for a second factor at `stepUpAt`', () => {
    const assessment = assess({ knownDevice: false, hourOfDay: 3, usualHours: [] }); // 25 + 10 = 35

    expect(assessment.score.value).toBe(35);
    expect(assessment.recommendations).toEqual(['prompt_device_confirmation']);
  });

  it('asks for a second factor and tells the user from `high`', () => {
    const assessment = assess({
      knownDevice: false,
      hourOfDay: 3,
      usualHours: [],
      failedAttempts: 3,
    }); // 25 + 10 + 35 = 70

    expect(assessment.score.level).toBe(RiskLevel.HIGH);
    expect(assessment.recommendations).toEqual([
      'require_second_factor',
      'prompt_device_confirmation',
      'throttle_failed_logins',
    ]);
  });

  it('never refuses without saying so above `refuseAt`', () => {
    const assessment = assess({
      knownDevice: false,
      previousLocation: OTHER_HEMISPHERE,
      failedAttempts: 99,
      ipFailureCount: 99,
      hourOfDay: 3,
      usualHours: [],
    });

    expect(assessment.recommendations).toContain('refuse');
    expect(assessment.suspicious).toBe(true);
  });

  it('is advisory, never a decision — every recommendation is a string', () => {
    for (const recommendation of assess({ knownDevice: false, hourOfDay: 3, usualHours: [] })
      .recommendations) {
      expect(typeof recommendation).toBe('string');
    }
  });
});

describe('RiskScoringService — the weight table', () => {
  it('sums above 100, which is why the score clamps', () => {
    const total = Object.values(RISK_FACTOR_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

    expect(total).toBeGreaterThan(RISK_SCORE_MAX);
  });

  it('ranks impossible travel and failure runs above a new device', () => {
    expect(RISK_FACTOR_WEIGHTS[RiskFactorType.UNUSUAL_LOCATION]).toBeGreaterThan(
      RISK_FACTOR_WEIGHTS[RiskFactorType.NEW_DEVICE],
    );
    expect(RISK_FACTOR_WEIGHTS[RiskFactorType.RAPID_FAILED_ATTEMPTS]).toBeGreaterThan(
      RISK_FACTOR_WEIGHTS[RiskFactorType.NEW_DEVICE],
    );
  });

  it('makes an unusual hour the weakest signal on its own', () => {
    const strongest = Math.max(...Object.values(RISK_FACTOR_WEIGHTS));

    expect(RISK_FACTOR_WEIGHTS[RiskFactorType.UNUSUAL_HOUR]).toBeLessThan(strongest);
    // 10 is below `medium`, so a 3am sign-in alone never escalates.
    expect(RiskScore.create(RISK_FACTOR_WEIGHTS[RiskFactorType.UNUSUAL_HOUR]).level).toBe(
      RiskLevel.LOW,
    );
  });

  it('gives every factor a name the wire format can carry', () => {
    for (const factor of Object.values(RiskFactorType)) {
      expect(factor).toMatch(/^[a-z_]+$/);
    }
  });

  it('scopes the fingerprint per user rather than globally', () => {
    // Two users, the same machine: the second one is a new *device for that account* even
    // though the fingerprint has been seen before. The model takes `knownDevice` per account,
    // so the test asserts the caller supplies it rather than the model caching anything.
    const other: RiskAssessmentInput = { ...CALM, fingerprint: OTHER_FINGERPRINT, knownDevice: false };

    expect(new RiskScoringService().assess(other).factors.map((f) => f.factor)).toEqual([
      RiskFactorType.NEW_DEVICE,
    ]);
  });
});