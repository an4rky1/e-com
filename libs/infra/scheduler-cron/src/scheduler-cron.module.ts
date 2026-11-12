import { type DynamicModule, Global, Module } from '@nestjs/common';
import { DistributedLockingModule } from '@auth/infra/distributed-locking';
import {
  SCHEDULER_CONFIG,
  resolveSchedulerConfig,
  type SchedulerConfig,
} from './scheduler-cron.config';
import { SchedulerCronService } from './scheduler-cron.service';

/**
 * Interval jobs safe to run in every replica of a service.
 *
 * @remarks The lock that makes a tick fleet-wide comes from `DistributedLockingModule`,
 * imported here so a host that asks for a scheduler gets the whole mechanism without
 * having to know that a scheduler is, underneath, a cron-shaped lock.
 */
@Global()
@Module({})
export class SchedulerCronModule {
  static register(options: { config?: Partial<SchedulerConfig> } = {}): DynamicModule {
    const config = resolveSchedulerConfig();

    return {
      module: SchedulerCronModule,
      imports: [DistributedLockingModule.register()],
      providers: [
        { provide: SCHEDULER_CONFIG, useValue: { ...config, ...options } },
        SchedulerCronService,
      ],
      exports: [SchedulerCronService, SCHEDULER_CONFIG],
    };
  }
}
