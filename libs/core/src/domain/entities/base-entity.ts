import type { IDomainEvent } from '../events/domain-event';

export abstract class BaseEntity<TId> {
  constructor(
    public readonly id: TId,
    public readonly createdAt: Date = new Date(),
    public updatedAt: Date = new Date(),
    public deletedAt: Date | null = null,
  ) {}

  equals(other: BaseEntity<TId> | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    if (other === this) return true;
    return other.id === this.id;
  }

  get isDeleted(): boolean {
    return this.deletedAt !== null;
  }

  /**
   * Soft delete. Hard-deleting an aggregate orphans every event that referenced it, so
   * deletion is recorded as a state transition and the row is retained.
   */
  softDelete(deletedAt: Date = new Date()): void {
    if (this.isDeleted) return;
    this.deletedAt = deletedAt;
    this.updatedAt = deletedAt;
  }

  restore(): void {
    if (!this.isDeleted) return;
    this.deletedAt = null;
    this.updatedAt = new Date();
  }

  protected touch(now: Date = new Date()): void {
    this.updatedAt = now;
  }
}

/**
 * Consistency boundary. Only the aggregate root is loaded and stored as a unit, which is
 * what makes the outbox's "state and events commit together" guarantee meaningful.
 */
export abstract class AggregateRoot<TId> extends BaseEntity<TId> {
  private _domainEvents: IDomainEvent[] = [];

  protected addDomainEvent(event: IDomainEvent): void {
    this._domainEvents.push(event);
  }

  get domainEvents(): ReadonlyArray<IDomainEvent> {
    return this._domainEvents;
  }

  get version(): number {
    const last = this._domainEvents[this._domainEvents.length - 1];
    return last ? last.version : 0;
  }

  /**
   * Drains buffered events.
   *
   * @remarks Clears the buffer so a second `save()` cannot re-insert events the first one
   * already persisted. Forgetting this is how duplicate `user.created` messages appear.
   */
  clearDomainEvents(): IDomainEvent[] {
    const drained = this._domainEvents;
    this._domainEvents = [];
    return drained;
  }
}