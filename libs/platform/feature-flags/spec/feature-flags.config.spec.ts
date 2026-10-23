/**
 * @fileoverview `FEATURE_FLAGS_*` parsing: one allowlist, validated at boot.
 *
 * @remarks The contract an operator sees: an unset namespace means every flag is off, a
 * comma-separated list turns flags on, and a name nobody can ever enable (an uppercase or
 * spaced typo) fails the boot rather than sitting silently off until someone notices the
 * feature never shipped.
 */
import { resolveFeatureFlagsConfig, Defaults } from '../src/feature-flags.config';

const resolve = (env: Record<string, string | undefined>) =>
  resolveFeatureFlagsConfig(env as NodeJS.ProcessEnv);

describe('FEATURE_FLAGS config', () => {
  it('defaults to an empty set: every flag is off', () => {
    const config = resolve({});
    expect(config.active).toEqual([]);
    expect(Defaults.ACTIVE).toBe('');
  });

  it('reads a comma-separated allowlist', () => {
    expect(resolve({ FEATURE_FLAGS_ACTIVE: 'new-login,search-v2' }).active).toEqual([
      'new-login',
      'search-v2',
    ]);
  });

  it('trims separators and drops empty entries', () => {
    expect(
      resolve({ FEATURE_FLAGS_ACTIVE: ' new-login ,, ,search-v2 ' }).active,
    ).toEqual(['new-login', 'search-v2']);
  });

  it('rejects a name that can never be matched, so typos fail the boot', () => {
    expect(() => resolve({ FEATURE_FLAGS_ACTIVE: 'New-Login' })).toThrow(
      /FEATURE_FLAGS_ACTIVE/,
    );
  });

  it('rejects a name with spaces rather than silently splitting it', () => {
    expect(() => resolve({ FEATURE_FLAGS_ACTIVE: 'new login' })).toThrow(
      /FEATURE_FLAGS_ACTIVE/,
    );
  });
});
