import type { Queue } from 'bullmq';
import type { OnModuleDestroy } from '@nestjs/common';

/**
 * The service's BullMQ queues, by name.
 *
 * @remarks A registry rather than one provider per queue: queue names are data (the app passes
 * a list to `QueueModule.register`), and a token per name would mean a Nest provider per entry
 * in what is, structurally, a map. `get` returns null for a name that was never registered —
 * a caller that typed a name wrong discovers it as an absent queue, not as a boot failure in
 * a module that never promised that name.
 */
export class BullQueueService implements OnModuleDestroy {
  constructor(private readonly queues: ReadonlyMap<string, Queue>) {}

  get(name: string): Queue | null {
    return this.queues.get(name) ?? null;
  }

  /** Registered names, for a boot log or a dashboard listing. */
  names(): string[] {
    return [...this.queues.keys()];
  }

  async onModuleDestroy(): Promise<void> {
    // allSettled, not all: one queue that refuses to close must not prevent the others from
    // draining, and shutdown is exactly when a stuck close is most likely.
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
  }
}
