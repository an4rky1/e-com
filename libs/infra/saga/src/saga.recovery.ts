import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SagaRunner } from './saga-runner.service';
import { SAGA_CONFIG, type SagaConfig } from './saga.tokens';

/**
 * Periodic sweep of interrupted sagas.
 *
 * @remarks Hooked to `onApplicationBootstrap`, not the constructor, for the same reason as the
 * outbox relay: a provider nothing injects is never instantiated, and a recovery sweeper that
 * never starts is indistinguishable from a saga engine that silently drops every interrupted
 * instance.
 *
 * @remarks One sweep at a time. Two overlapping ticks would race on the same stale instances;
 * the optimistic claim means only one would win each, but the loser would burn its retry
 * budget failing to claim — noise with no upside.
 */
@Injectable()
export class SagaRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SagaRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private ticking = false;

  constructor(
    private readonly runner: SagaRunner,
    @Inject(SAGA_CONFIG) private readonly config: SagaConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.warn(
        'saga recovery is disabled; interrupted sagas will wait for a restart',
      );
      return;
    }
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
    // No drain accounting like the outbox's: a saga interrupted by shutdown is exactly what
    // the next boot's sweep is for, and waiting for in-flight sagas would hold the process
    // open for the full step timeout.
  }

  /** One sweep. Public so tests can drive recovery deterministically. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const report = await this.runner.recover();
      if (report.scanned > 0) {
        this.logger.log(
          `swept ${report.scanned} interrupted saga(s): ${report.resumed} resumed, ${report.compensated} compensated, ${report.failed} failed, ${report.skipped} skipped`,
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => {
          // A sweeper that stops on the first unexpected error stops recovering for the
          // lifetime of the process, with nothing to signal it.
          this.logger.error('saga recovery tick failed; continuing', error);
        })
        .finally(() => this.schedule(this.config.recoveryIntervalMs));
    }, delayMs);

    this.timer.unref?.();
  }
}
