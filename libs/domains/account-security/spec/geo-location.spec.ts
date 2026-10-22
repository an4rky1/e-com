/**
 * Geolocation.
 *
 * @remarks The city pairs are real coordinates with independently verifiable distances, and the
 * expected numbers are quoted to three decimal places with a tight tolerance. A haversine that is
 * "roughly right" is not good enough here: the impossible-travel factor compares it against a
 * threshold in kilometres, so a 2% error is a 2% error in who gets flagged.
 */
import {
  DEFAULT_IMPOSSIBLE_TRAVEL_KM,
  EARTH_RADIUS_KM,
  GeoLocation,
  haversineDistanceKm,
} from '../src/domain/value-objects/geo-location.vo';

const LONDON = GeoLocation.of(51.5074, -0.1278, 'GB');
const PARIS = GeoLocation.of(48.8566, 2.3522, 'FR');
const BERLIN = GeoLocation.of(52.52, 13.405, 'DE');
const MELBOURNE = GeoLocation.of(-37.8136, 144.9631, 'AU');
const NEW_YORK = GeoLocation.of(40.7128, -74.006, 'US');
const SYDNEY = GeoLocation.of(-33.8688, 151.2093, 'AU');

describe('haversineDistanceKm — known pairs', () => {
  const cases: ReadonlyArray<readonly [string, GeoLocation, GeoLocation, number]> = [
    ['London -> Paris', LONDON, PARIS, 343.556],
    ['London -> Berlin', LONDON, BERLIN, 931.569],
    ['London -> New York', LONDON, NEW_YORK, 5570.222],
    ['Melbourne -> Sydney', MELBOURNE, SYDNEY, 713.427],
    ['Sydney -> Melbourne', SYDNEY, MELBOURNE, 713.427],
  ];

  it.each(cases)('%s', (_label, from, to, expected) => {
    // 0.5 km of tolerance: floating point, not the formula, is the only error source.
    expect(haversineDistanceKm(from, to)).toBeCloseTo(expected, 0);
    expect(Math.abs(from.distanceToKm(to) - expected)).toBeLessThan(0.5);
  });

  it('is zero for identical points', () => {
    expect(LONDON.distanceToKm(LONDON)).toBe(0);
    expect(haversineDistanceKm(LONDON, LONDON)).toBe(0);
  });

  it('is symmetric', () => {
    expect(LONDON.distanceToKm(PARIS)).toBeCloseTo(PARIS.distanceToKm(LONDON), 10);
  });

  it('is zero across the equator for the same meridian', () => {
    const north = GeoLocation.of(1, 10);
    const south = GeoLocation.of(-1, 10);

    expect(north.distanceToKm(south)).toBeCloseTo(222.6, 0);
  });

  it('stays finite at the antipodes instead of returning NaN', () => {
    const a = GeoLocation.of(0, 0);
    const b = GeoLocation.of(0, 180);
    const distance = a.distanceToKm(b);

    expect(Number.isNaN(distance)).toBe(false);
    expect(distance).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 0);
  });
});

describe('GeoLocation — construction', () => {
  it('normalises the country to upper case so a comparison is meaningful', () => {
    expect(GeoLocation.of(51.5, -0.12, 'gb').country).toBe('GB');
  });

  it('treats a blank country as unknown rather than as an empty string', () => {
    expect(GeoLocation.of(51.5, -0.12, '   ').country).toBeNull();
  });

  it('refuses a latitude off the globe rather than clamping it', () => {
    expect(() => GeoLocation.of(95, 0)).toThrow();
    expect(() => GeoLocation.of(0, 181)).toThrow();
  });
});

describe('GeoLocation — unusual travel', () => {
  const threshold = DEFAULT_IMPOSSIBLE_TRAVEL_KM;

  it('does not flag a login from the same place', () => {
    expect(PARIS.isUnusualFrom(PARIS, threshold)).toBe(false);
  });

  it('does not flag a commute across one country', () => {
    expect(LONDON.distanceToKm(PARIS)).toBeLessThan(threshold);
    expect(LONDON.isUnusualFrom(PARIS, threshold)).toBe(false);
  });

  it('does flag two European capitals more than a threshold apart', () => {
    // Berlin is 931 km from London, so a 500 km threshold separates the two cases on real data
    // rather than on a contrived coordinate.
    expect(LONDON.distanceToKm(BERLIN)).toBeGreaterThan(threshold);
    expect(LONDON.isUnusualFrom(BERLIN, threshold)).toBe(true);
  });

  it('flags a hop across an ocean', () => {
    expect(NEW_YORK.isUnusualFrom(LONDON, threshold)).toBe(true);
  });

  it('flags strictly *beyond* the threshold, never at it', () => {
    // The threshold is compared against the distance this very point computes, so "exactly at"
    // is exact rather than approximated: no rounding decides whether someone gets flagged.
    const probe = GeoLocation.of(52, -0.1278);
    const exact = probe.distanceToKm(LONDON);

    expect(probe.isUnusualFrom(LONDON, exact)).toBe(false);
    expect(probe.isUnusualFrom(LONDON, exact - 0.001)).toBe(true);
  });

  it('does not flag anything when there is no history to compare against', () => {
    // "We have no idea where they were" is not evidence of travel. Treating the absence as a
    // maximum-distance jump would make every user's second device look like a hijack.
    expect(SYDNEY.isUnusualFrom(null, threshold)).toBe(false);
    expect(SYDNEY.isUnusualFrom(undefined, threshold)).toBe(false);
  });
});
