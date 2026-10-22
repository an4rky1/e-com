import type {
  AggregateRoot,
  IDomainEvent,
  IRepository,
  ISpecification,
  PaginatedResult,
  PaginationOptions,
} from '@auth/ddd-core';
import type { PrismaClientLike, PrismaService } from './prisma.service';

/**
 * Repository base with the ambient-transaction guarantee baked in.
 *
 * @remarks Every subclass reads `this.prisma.tx`, never `this.prisma` directly. That single
 * convention is what makes `save(aggregate)` atomic together with the outbox rows written
 * by the same handler: inside a transaction both commit together, and there is no path
 * where the state lands but the event does not.
 */
export abstract class PrismaRepository<
  TEntity extends AggregateRoot<string>,
  TClient extends PrismaClientLike,
> implements IRepository<TEntity, string>
{
  protected constructor(
    protected readonly prisma: PrismaService<TClient>,
  ) {}

  /**
   * Persists the aggregate, then drains its domain events.
   *
   * @remarks Draining happens after the write so an in-memory handler still sees the events;
   * clearing them prevents a second `save()` from re-inserting what already persisted.
   */
  async save(entity: TEntity): Promise<void> {
    await this.persist(entity);
    entity.clearDomainEvents();
  }

  /** Persists and hands the drained events to `onSaved`, inside the caller's transaction. */
  async saveWithEvents(
    entity: TEntity,
    onSaved: (events: IDomainEvent[]) => Promise<void>,
  ): Promise<void> {
    const events = entity.clearDomainEvents();
    await this.persist(entity);
    await onSaved(events);
  }

  protected abstract persist(entity: TEntity): Promise<void>;

  abstract findById(id: string): Promise<TEntity | null>;

  abstract find(spec: ISpecification<TEntity>): Promise<TEntity[]>;

  async findMany(
    spec: ISpecification<TEntity>,
    options: PaginationOptions = {},
  ): Promise<PaginatedResult<TEntity>> {
    const page = Math.max(options.page ?? 1, 1);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
    const total = await this.count(spec);

    const ordered = options.sortBy
      ? sortByKey(await this.find(spec), options.sortBy, options.sortOrder ?? 'asc')
      : await this.find(spec);

    const offset = (page - 1) * limit;

    return {
      data: ordered.slice(offset, offset + limit),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async exists(spec: ISpecification<TEntity>): Promise<boolean> {
    return (await this.count(spec)) > 0;
  }

  async count(spec: ISpecification<TEntity>): Promise<number> {
    return (await this.find(spec)).length;
  }

  /** Soft by default: the row is retained so events referencing it still resolve. */
  async delete(entity: TEntity): Promise<void> {
    entity.softDelete();
    await this.persist(entity);
  }
}

function sortByKey<TEntity>(
  entities: TEntity[],
  key: string,
  order: 'asc' | 'desc',
): TEntity[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...entities].sort((left, right) => {
    const a = (left as unknown as Record<string, unknown>)[key];
    const b = (right as unknown as Record<string, unknown>)[key];
    if (a === b) return 0;
    if (a === undefined || a === null) return 1;
    if (b === undefined || b === null) return -1;
    return (a < b ? -1 : 1) * direction;
  });
}