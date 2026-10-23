/**
 * @fileoverview Prisma persistence for {@link MfaFactor} and its spent-step marker.
 *
 * @remarks Three writes, one transaction: the factor, `totp_used_counters` and the outbox
 * rows. That grouping is not tidiness — the counter row *is* the replay defence, so a
 * verification that advanced the factor without recording the step it spent would let the
 * same six digits authenticate a second time. Writing the marker separately is the one
 * arrangement that makes replay protection optional.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import type { IDomainEvent } from '@auth/core';
import type { MfaMethod } from '../../domain/value-objects/mfa-method.vo';
import type { MfaFactorRepositoryPort } from '../../domain/ports/mfa-factor-repository.port';
import { MfaFactor, type MfaFactorRow } from '../../domain/mfa-factor.aggregate';
import { MFA_PRISMA } from '../../mfa.config';
import type { PrismaClient } from '../../generated/prisma/client';
import { enqueueEvents } from './outbox-enqueue';

/** Everything a factor row needs, read off the aggregate. */
const rowOf = (factor: MfaFactor) => ({
  id: factor.id,
  user_id: factor.userId,
  method: factor.method,
  status: factor.status,
  account_label: factor.accountLabel,
  destination_hint: factor.destinationHint,
  secret_ciphertext: factor.secretCiphertext,
  secret_hash: null,
  pending_secret_kind: factor.pendingSecretKind,
  pending_secret_value: factor.pendingSecretValue,
  pending_secret_expires_at: factor.pendingSecretExpiresAt,
  failed_attempts: factor.failedAttempts,
  locked_until: factor.lockedUntil,
  activated_at: factor.activatedAt,
  last_verified_at: factor.lastVerifiedAt,
  version: factor.factorVersion,
  created_at: factor.createdAt,
  updated_at: factor.updatedAt,
});

/**
 * The include that rehydration needs.
 *
 * @remarks Not a "nice to have". Loading a factor without `totp_used_counters` resets the
 * spent-step marker to `null`, which silently accepts every code the factor has already
 * used — a bug that would surface only as "sometimes a replayed code works".
 */
const WITH_COUNTER = { totp_used_counters: true } as const;

@Injectable()
export class PrismaMfaFactorRepository implements MfaFactorRepositoryPort {
  private readonly logger = new Logger(PrismaMfaFactorRepository.name);

  constructor(
    @Inject(MFA_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  /**
   * Joins the caller's transaction, or opens one.
   *
   * @remarks The handlers open theirs through the unit of work, because a command that writes
   * a factor and a recovery code needs both halves in one boundary. Opening a second
   * transaction here when one is already ambient would silently give the counter row its own
   * commit point — so the ambient case is detected and the writes are joined instead.
   */
  async save(factor: MfaFactor): Promise<void> {
    const events = factor.clearDomainEvents();

    if (this.prisma.inTransaction) {
      await this.write(factor, events);
      return;
    }
    await this.prisma.runInTransaction((client) => this.write(factor, events, client));
  }

  private async write(
    factor: MfaFactor,
    events: readonly IDomainEvent[],
    client: PrismaClient = this.prisma.tx,
  ): Promise<void> {
    const row = rowOf(factor);

    await client.mfa_factors.upsert({
      where: { id: factor.id },
      create: row,
      update: row,
    });

    await this.writeCounter(factor, client);
    await enqueueEvents(client, events, {
      logger: this.logger,
      partitionKey: (event) => event.aggregateId,
    });
  }

  /**
   * Keeps `totp_used_counters` in step with the aggregate's marker.
   *
   * @remarks Deleting the row when there is no marker is deliberate rather than tidy: the
   * marker is reset when a factor is disabled, and a stale row would reject the very first
   * legitimate code of a re-enrollment if the factor were ever revived by an operator.
   */
  private async writeCounter(factor: MfaFactor, client: PrismaClient): Promise<void> {
    if (factor.lastUsedCounter === null) {
      await client.totp_used_counters.deleteMany({ where: { factor_id: factor.id } });
      return;
    }

    await client.totp_used_counters.upsert({
      where: { factor_id: factor.id },
      create: {
        factor_id: factor.id,
        last_counter: factor.lastUsedCounter,
        updated_at: factor.updatedAt,
      },
      update: {
        last_counter: factor.lastUsedCounter,
        updated_at: factor.updatedAt,
      },
    });
  }

  async findById(id: string): Promise<MfaFactor | null> {
    const row = await this.prisma.tx.mfa_factors.findUnique({
      where: { id },
      include: WITH_COUNTER,
    });
    return row ? MfaFactor.fromRow(row as unknown as MfaFactorRow) : null;
  }

  async findByUser(userId: string): Promise<MfaFactor[]> {
    const rows = await this.prisma.tx.mfa_factors.findMany({
      where: { user_id: userId },
      include: WITH_COUNTER,
      orderBy: { created_at: 'desc' },
    });
    return rows.map((row) => MfaFactor.fromRow(row as unknown as MfaFactorRow));
  }

  /**
   * The user's live factor for a method.
   *
   * @remarks The `status` filter is in the query rather than in a post-read `find`, because a
   * user may legitimately hold several `pending` factors from abandoned enrollments and only
   * one of them is the second factor.
   */
  async findActiveByUserAndMethod(
    userId: string,
    method: MfaMethod,
  ): Promise<MfaFactor | null> {
    const row = await this.prisma.tx.mfa_factors.findFirst({
      where: { user_id: userId, method, status: 'active' },
      include: WITH_COUNTER,
      orderBy: { created_at: 'desc' },
    });
    return row ? MfaFactor.fromRow(row as unknown as MfaFactorRow) : null;
  }

  async count(): Promise<number> {
    return this.prisma.tx.mfa_factors.count();
  }
}