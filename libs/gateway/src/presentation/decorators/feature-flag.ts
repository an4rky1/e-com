/**
 * @fileoverview Gates a route behind one or more feature flags.
 *
 * @remarks Several flags mean AND: the route exists only while every one of them is on. That
 * is the composition a release train actually needs ("new flow AND new billing"), and the
 * opposite — ANY — turns two half-shipped flags into an accidentally live endpoint.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const FEATURE_FLAG = Symbol('FEATURE_FLAG');

export const FeatureFlag = (...flags: string[]): CustomDecorator<symbol> =>
  SetMetadata(FEATURE_FLAG, flags);
