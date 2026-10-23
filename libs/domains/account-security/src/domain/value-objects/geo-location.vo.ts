/**
 * @fileoverview Where a login came from, and how far away that is.
 *
 * @remarks Geolocation here is *evidence*, not truth. The coordinates come from the caller's
 * edge or an IP database and are routinely wrong by a city, so nothing here decides whether to
 * block anything; it only produces a distance for the scoring service to weigh.
 */
import { Ensure, ValueObject } from '@auth/core';

/** Mean earth radius in kilometres — the value every published haversine uses. */
export const EARTH_RADIUS_KM = 6371;

/**
 * How far apart two logins have to be before the second one is "unusual".
 *
 * @remarks 500 km, not "any distance at all". A user who signs in from home and then from the
 * office two kilometres away is not an attack, and a threshold small enough to flag that would
 * flag a VPN. A threshold this large still catches the case that matters — London to Tokyo, or
 * two continents inside a credential-guessing run — and deliberately leaves room for the
 * inaccuracy of the coordinates themselves.
 */
export const DEFAULT_IMPOSSIBLE_TRAVEL_KM = 500;

/** A point on the earth's surface. */
export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export class GeoLocation extends ValueObject<{
  latitude: number;
  longitude: number;
  country: string | null;
}> {
  private constructor(
    latitude: number,
    longitude: number,
    country: string | null,
  ) {
    super({ latitude, longitude, country });
  }

  /**
   * A location from a point.
   *
   * @remarks The coordinate range is asserted rather than clamped. A latitude of `95` is not a
   * location, and silently clamping it to the pole would put a broken caller in the Arctic and
   * make every distance computed against it meaningless.
   */
  static of(latitude: number, longitude: number, country?: string | null): GeoLocation {
    Ensure.inRange(latitude, -90, 90, 'latitude');
    Ensure.inRange(longitude, -180, 180, 'longitude');

    const normalisedCountry = country?.trim().toUpperCase() || null;
    return new GeoLocation(latitude, longitude, normalisedCountry);
  }

  /** Rehydration from storage, where a malformed row is reported rather than rejected. */
  static fromRow(latitude: number, longitude: number, country: string | null): GeoLocation {
    return new GeoLocation(latitude, longitude, country?.trim().toUpperCase() || null);
  }

  get latitude(): number {
    return this.props.latitude;
  }

  get longitude(): number {
    return this.props.longitude;
  }

  get country(): string | null {
    return this.props.country;
  }

  /** Great-circle distance to another point, in kilometres. */
  distanceToKm(other: GeoLocation): number {
    return haversineDistanceKm(this, other);
  }

  /**
   * Whether reaching this point from `previous` is far enough to be worth scoring.
   *
   * @remarks With no previous location there is nothing to compare against, and the answer is
   * `false` — "we have no history" is not evidence of travel. Treating the absence as a
   * maximum-distance jump would score every user's first sign-in from their second device as a
   * hijack.
   */
  isUnusualFrom(
    previous: GeoLocation | null | undefined,
    thresholdKm: number = DEFAULT_IMPOSSIBLE_TRAVEL_KM,
  ): boolean {
    if (!previous) return false;
    return this.distanceToKm(previous) > thresholdKm;
  }
}

/**
 * Great-circle distance between two coordinates, in kilometres.
 *
 * @remarks Haversine rather than the law of cosines because the latter loses precision at
 * short range: two logins from the same office block are a few hundred metres apart, and that
 * is exactly the comparison the "did they move at all" case depends on. `asin(sqrt(h))` is the
 * numerically stable half-angle form for the same reason.
 */
export function haversineDistanceKm(from: Coordinates, to: Coordinates): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;

  // `min(1, ...)` guards the sqrt: at the antipodes `a` evaluates to 1.0000000000000002 on
  // some platforms, and Math.sqrt of that is NaN.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Whether two coordinates are close enough to be the same place for "usual hour" purposes. */
export function isSameCountry(a: GeoLocation | null, b: GeoLocation | null): boolean {
  if (!a || !b) return false;
  return a.country !== null && a.country === b.country;
}