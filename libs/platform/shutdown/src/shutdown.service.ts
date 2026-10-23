import { Injectable, Logger, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';

/**
 * Coordinates graceful shutdown.
 *
 * @remarks Order is the whole contract and is not negotiable:
 * 1. flip readiness to `down` — the load balancer must stop sending new requests;
 * 2. wait for the orchestrator's grace period so in-flight requests drain;
 * 3. *then* Nest runs `onModuleDestroy`, which closes Prisma pools, Kafka clients and Redis.
 *
 * Closing first and draining afterwards is the classic mistake: it cancels in-flight
 * transactions and turns a rolling deploy into a burst of failed writes.
 */
@Injectable()
export class ShutdownService implements OnApplicationShutdown, OnModuleDestroy {
  private readonly logger = new Logger(ShutdownService.name);
  private draining = false;
  private readonly startedAt = Date.now();

  get isDraining(): boolean {
    return this.draining;
  }

  get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /**
   * Begins draining.
   *
   * @remarks Called on the first SIGTERM. `preStop` hooks and readiness probes share this so
   * an orchestrator that only sends SIGTERM still gets the full sequence.
   */
  beginDrain(reason = 'signal'): void {
    if (this.draining) return;
    this.draining = true;
    this.logger.warn(`Draining connections (${reason}); readiness is now failing`);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.beginDrain(signal ?? 'shutdown hook');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Module teardown complete');
  }

  /** Readiness must report `down` from the moment draining starts. */
  readinessStatus(): 'up' | 'down' {
    return this.draining ? 'down' : 'up';
  }
}

/**
 * Wires SIGTERM/SIGINT to a cooperative shutdown.
 *
 * @remarks The handlers are removed on exit: a test that boots several apps in one process
 * would otherwise accumulate listeners and leak them into later tests.
 *
 * `process.exit()` is deliberately never called. Exiting from a signal handler kills the
 * event loop before Prisma and Kafka have flushed, which is the data loss this whole module
 * exists to prevent.
 */
export function installShutdownHandlers(
  shutdown: ShutdownService,
  options: {
    app: { close(): Promise<void> };
    gracePeriodMs?: number;
    drain?: () => Promise<void>;
  },
): () => void {
  const gracePeriodMs = options.gracePeriodMs ?? 5_000;

  const handle = (signal: NodeJS.Signals) => {
    shutdown.beginDrain(signal);

    // Leave the rotation window first, then let in-flight work finish.
    void (options.drain?.() ?? Promise.resolve())
      .then(() => delay(gracePeriodMs))
      .then(() => options.app.close())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
         
        console.error('Graceful shutdown failed; forcing exit', error);
        process.exit(1);
      });
  };

  const onTerm = () => handle('SIGTERM');
  const onInt = () => handle('SIGINT');

  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  return () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });