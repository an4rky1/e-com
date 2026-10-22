/**
 * @fileoverview Repository ports.
 *
 * Why the port lives in the domain: the aggregate must be able to say "load me and save me"
 * without knowing that Postgres exists. The interface is the seam; the Prisma
 * implementation in `@auth/infra/prisma` is interchangeable with an in-memory one in tests.
 */

import type { IDomainEvent } from '../events/domain-event';

export interface PaginationOptions {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<TEntity> {
  data: TEntity[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ISpecification<TEntity> {
  isSatisfiedBy(entity: TEntity): boolean;
  and(other: ISpecification<TEntity>): ISpecification<TEntity>;
  or(other: ISpecification<TEntity>): ISpecification<TEntity>;
  not(): ISpecification<TEntity>;
}

export interface IRepository<TEntity, TId> {
  /**
   * Persists the aggregate *and* its pending domain events atomically.
   *
   * @remarks Implementations must honour this contract. Saving state first and events
   * afterwards leaves a window where the write committed but the event never fired, and
   * no consumer ever hears about the change.
   */
  save(entity: TEntity): Promise<void>;

  findById(id: TId): Promise<TEntity | null>;
  find(spec: ISpecification<TEntity>): Promise<TEntity[]>;
  findMany(
    spec: ISpecification<TEntity>,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<TEntity>>;
  exists(spec: ISpecification<TEntity>): Promise<boolean>;
  count(spec: ISpecification<TEntity>): Promise<number>;
  /** Soft delete by default: the row is retained so history stays resolvable. */
  delete(entity: TEntity): Promise<void>;
}

export interface IEventSourcedRepository<TEntity, TId> {
  loadFromHistory(id: TId): Promise<TEntity | null>;
  saveWithEvents(entity: TEntity, events: readonly IDomainEvent[]): Promise<void>;
}