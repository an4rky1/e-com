/**
 * @fileoverview `FeatureFlagsService`: a flag is on only when the allowlist says so.
 *
 * @remarks Both halves of the contract matter: a listed flag answers true, and — the half
 * that saves a release — an unlisted or misspelled flag answers false rather than throwing
 * at the call site. The caller has one job (ask), the config has another (decide).
 */
import { FeatureFlagsService } from '../src/feature-flags.service';
import type { FeatureFlagsConfig } from '../src/feature-flags.config';

const service = (active: string[]): FeatureFlagsService =>
  new FeatureFlagsService({ active } satisfies FeatureFlagsConfig);

describe('FeatureFlagsService', () => {
  it('enables a listed flag', () => {
    expect(service(['new-login']).isEnabled('new-login')).toBe(true);
  });

  it('keeps every unlisted flag off', () => {
    const flags = service(['new-login']);
    expect(flags.isEnabled('search-v2')).toBe(false);
  });

  it('answers false for a flag that was never declared, not an error', () => {
    expect(service([]).isEnabled('typo-flag')).toBe(false);
  });

  it('exposes the active set for diagnostics', () => {
    expect(service(['a', 'b']).activeFlags()).toEqual(['a', 'b']);
  });
});
