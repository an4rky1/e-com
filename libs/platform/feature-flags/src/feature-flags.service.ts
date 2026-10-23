import { Inject, Injectable } from '@nestjs/common';
import { FEATURE_FLAGS_CONFIG, type FeatureFlagsConfig } from './feature-flags.config';

export const FEATURE_FLAGS = Symbol('FEATURE_FLAGS');

/**
 * Answers "is this flag on?" for the rest of the service.
 *
 * @remarks Evaluation is a set lookup against the parsed config, resolved once at boot. This
 * is not an experimentation platform: there is no percentage rollout, no user segmentation
 * and no remote evaluation, because none of them pays for itself until a real experiment
 * needs them. When one does, the switch grows a provider behind this same token and no
 * caller changes.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(@Inject(FEATURE_FLAGS_CONFIG) private readonly config: FeatureFlagsConfig) {}

  isEnabled(flag: string): boolean {
    return this.config.active.includes(flag);
  }

  /** The active set, for boot logs and diagnostics. */
  activeFlags(): readonly string[] {
    return this.config.active;
  }
}
