import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { TransactionStorage } from './transaction-storage';

/**
 * The surface a generated Prisma client exposes, independent of which service generated it.
 *
 * @remarks The platform lib must not import a generated client: there is one client per
 * service (that is what makes table ownership a compile error), and a lib that named any
 * of them would couple every service to one schema.
 */
export interface PrismaClientLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  /**
   * Tagged-template form only.
   *
   * @remarks Prisma's own overload also accepts a prebuilt `Sql` object and `string`. Narrowing
   * it here keeps every generated client structurally assignable to this interface, so a
   * service never has to cast its way past the platform lib.
   */
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  /**
   * Declared maximally permissively on purpose.
   *
   * @remarks Prisma exposes two overloads (an array form and an interactive-callback form),
   * and structural assignability is checked against the last one. A narrow signature here
   * would make every generated client look incompatible, forcing a cast at every boundary.
   * `runInTransaction` narrows back down to the callback form it actually uses.
   */
  $transaction: (...args: never[]) => Promise<unknown>;
}

/**
 * Owns one service's Prisma client plus the ambient-transaction plumbing.
 *
 * @remarks Prisma's interactive transactions take a callback rather than a client handle,
 * so a transaction client cannot simply be passed as an argument. `TransactionStorage`
 * bridges that gap: inside `runInTransaction`, `tx` resolves to the ambient client and every
 * repository joins the caller's transaction without being handed anything.
 */
@Injectable()
export class PrismaService<TClient extends PrismaClientLike = PrismaClientLike>
  implements OnModuleInit, OnModuleDestroy
{
  protected readonly logger = new Logger(PrismaService.name);
  private shuttingDown = false;

  constructor(
    protected readonly client: TClient,
    private readonly options: { logQueries?: boolean } = {},
  ) {
    if (options.logQueries) {
      (client as unknown as {
        $on(event: string, cb: (payload: unknown) => void): void;
      }).$on('query', (payload) => this.logger.debug(JSON.stringify(payload)));
    }
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  /**
   * Drains before closing.
   *
   * @remarks Order matters: stop accepting work, let in-flight transactions finish, then
   * release the pool. Disconnecting first cancels running transactions and turns a rolling
   * deploy into a burst of failed writes.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.client.$disconnect();
  }

  /**
   * Runs `fn` in a transaction, making the client ambient for its duration.
   *
   * @remarks `timeout` and `maxWait` are bounded so a blocked statement surfaces as a
   * rollback rather than pinning a pooled connection until the orchestrator kills the pod.
   */
  async runInTransaction<TResult>(
    fn: (client: TClient) => Promise<TResult>,
    options: { timeoutMs?: number; maxWaitMs?: number; traceId?: string } = {},
  ): Promise<TResult> {
    TransactionStorage.assertNotActive('PrismaService.runInTransaction');

    // Invoked as a method, never extracted into a local: `$transaction` relies on `this`, and
    // an extracted reference arrives with the receiver detached, so the transaction client
    // comes back undefined.
    const run = (tx: TClient) =>
      TransactionStorage.run({ client: tx, traceId: options.traceId }, () => fn(tx));

    return this.client.$transaction(run as never, {
      timeout: options.timeoutMs ?? 10_000,
      maxWait: options.maxWaitMs ?? 5_000,
    } as never) as Promise<TResult>;
  }

  /** The client a repository should use: ambient when in a transaction, else the root. */
  get tx(): TClient {
    return (TransactionStorage.get()?.client as TClient | undefined) ?? this.client;
  }

  get inTransaction(): boolean {
    return TransactionStorage.isActive;
  }
}