import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
// Value import on purpose: Nest resolves the constructor parameter from this binding
// (emitDecoratorMetadata); a type-only import would emit `Object` and leave DI unable to
// construct the reaper at boot.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CommandBus } from '@nestjs/cqrs';
import { IDENTITY_CONFIG, type IdentityConfig } from '../identity.config';
import { ReapGuestUsersCommand } from './commands/reap-guest-users.command';

/**
 * The clock behind the guest sweep.
 *
 * @remarks Its own timer rather than the fleet-wide scheduler: the sweep is a conditional
 * delete of rows nobody reads — two replicas running it at once do redundant work, not
 * wrong work — and identity has no distributed lock to share. The `running` flag keeps a
 * slow tick from overlapping itself on this replica; `unref` keeps the timer from being the
 * reason the process refuses to exit.
 */
@Injectable()
export class GuestReaperService implements OnApplicationBootstrap, OnModuleDestroy {
  private static readonly logger = new Logger(GuestReaperService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly commandBus: CommandBus,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.guestReapEnabled) {
      GuestReaperService.logger.log('guest reaping is disabled');
      return;
    }
    // First fire one interval from boot: a sweep racing the process's own warm-up would
    // delete against a connection that has not proved itself yet.
    this.schedule();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    this.timer = setTimeout(
      () => void this.tick(),
      this.config.guestReapIntervalSec * 1_000,
    );
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      this.schedule();
      return;
    }
    this.ticking = true;
    try {
      await this.commandBus.execute(new ReapGuestUsersCommand());
    } catch (error) {
      // A failed sweep is logged and retried next interval — stopping here would leave
      // abandoned guest rows accumulating silently for the rest of the deployment's life.
      GuestReaperService.logger.error(
        'guest sweep failed; retrying next interval',
        error as Error,
      );
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }
}
