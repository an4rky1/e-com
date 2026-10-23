import { z } from 'zod';
import { envString, readNamespacedEnv } from '@auth/platform/config';

export const FEATURE_FLAGS_CONFIG = Symbol('FEATURE_FLAGS_CONFIG');

export const Defaults = {
  /**
   * Comma-separated flags that are on. Everything not listed is off.
   *
   * @remarks Deliberately a single allowlist rather than one variable per flag: a flag that
   * exists in two places (schema and env) is a flag nobody is sure which half is wrong when
   * it misbehaves, and a schema that grows a field per product decision is a schema that
   * gets stale the week the product changes its mind.
   */
  ACTIVE: '',
} as const;

const FLAG_NAME = /^[a-z][a-z0-9-]*$/;

const schema = z.object({
  ACTIVE: envString(Defaults.ACTIVE)
    .transform((value) =>
      value
        .split(',')
        .map((flag) => flag.trim())
        .filter((flag) => flag.length > 0),
    )
    .pipe(
      z
        .array(z.string().regex(FLAG_NAME, 'flag names are kebab-case, e.g. "new-login"'))
        .describe('Flags that are enabled'),
    )
    .describe('Comma-separated flags that are enabled'),
});

export type FeatureFlagsEnvConfig = z.infer<typeof schema>;

export interface FeatureFlagsConfig {
  active: string[];
}

/**
 * feature-flags' own configuration namespace.
 *
 * @remarks One source of truth: a flag is on only when listed in `FEATURE_FLAGS_ACTIVE`.
 * There is no `ENABLED` master switch — "all flags off" is already the empty list, and a
 * second switch would be a place for two halves of the truth to disagree. There are no
 * code-side defaults either: a default baked into the code can only be turned off by a
 * deploy, which is the opposite of what a switch is for.
 */
export function resolveFeatureFlagsConfig(
  env: NodeJS.ProcessEnv = process.env,
): FeatureFlagsConfig {
  const parsed = readNamespacedEnv('FEATURE_FLAGS', schema, env);
  return { active: parsed.ACTIVE };
}
