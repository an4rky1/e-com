import { type DynamicModule, Global, Module } from '@nestjs/common';
import {
  FEATURE_FLAGS_CONFIG,
  resolveFeatureFlagsConfig,
  type FeatureFlagsConfig,
} from './feature-flags.config';
import { FEATURE_FLAGS, FeatureFlagsService } from './feature-flags.service';

/**
 * Feature flags from the `FEATURE_FLAGS_*` namespace.
 *
 * @remarks Config-only and deliberately dependency-free: no Redis, no remote service. A flag
 * that needs a healthy dependency to answer "off" is a flag that can take the service down
 * with it, and the whole point of a switch is that it keeps working when everything else
 * does not.
 */
@Global()
@Module({})
export class FeatureFlagsModule {
  static register(options: { config?: Partial<FeatureFlagsConfig> } = {}): DynamicModule {
    const config = resolveFeatureFlagsConfig();

    return {
      module: FeatureFlagsModule,
      providers: [
        { provide: FEATURE_FLAGS_CONFIG, useValue: { ...config, ...options } },
        { provide: FEATURE_FLAGS, useClass: FeatureFlagsService },
      ],
      exports: [FEATURE_FLAGS, FEATURE_FLAGS_CONFIG],
    };
  }
}
