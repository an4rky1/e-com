import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ENCRYPTION_CONFIG, resolveEncryptionConfig } from './encryption.config';
import { EncryptionService } from './encryption.service';

/**
 * Symmetric encryption for stored secrets.
 *
 * @remarks `@Global()` — every service that persists a PSP credential asks for this one,
 * and a module whose absence means "cannot boot" (the key is validated at registration)
 * should be wired once, at the root, not imported ad hoc where the check could be
 * skipped.
 */
@Global()
@Module({})
export class EncryptionModule {
  static register(): DynamicModule {
    return {
      module: EncryptionModule,
      providers: [
        { provide: ENCRYPTION_CONFIG, useValue: resolveEncryptionConfig() },
        EncryptionService,
      ],
      exports: [EncryptionService, ENCRYPTION_CONFIG],
    };
  }
}
