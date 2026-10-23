import { Controller, type DynamicModule, Get, Inject, Module } from '@nestjs/common';
import { HealthService } from './health.service';
import type { HealthReport } from './health.types';

export const HEALTH_SERVICE_NAME = Symbol('HEALTH_SERVICE_NAME');

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthService,
    @Inject(HEALTH_SERVICE_NAME) private readonly serviceName: string,
  ) {}

  /** Liveness. Never touches dependencies: a failing dependency must not restart the pod. */
  @Get()
  live(): HealthReport {
    return this.health.liveness();
  }

  /** Readiness. Reports `down` while draining so the balancer stops sending traffic. */
  @Get('ready')
  async ready(): Promise<HealthReport> {
    return this.health.readiness();
  }
}

@Module({
  controllers: [HealthController],
  exports: [HealthService],
})
export class HealthModule {
  static forRoot(serviceName: string): DynamicModule {
    return {
      module: HealthModule,
      providers: [
        { provide: HEALTH_SERVICE_NAME, useValue: serviceName },
        { provide: HealthService, useFactory: () => new HealthService(serviceName) },
      ],
      exports: [HealthService],
    };
  }
}