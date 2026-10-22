/**
 * @fileoverview Prisma persistence for {@link RecoveryCodeSet}.
 *
 * @remarks Two write paths because they are genuinely different operations: {@link replace}
 * is a rotation — destructive by design — while {@link consumeCode} spends exactly one row.
 *
 * @remarks `consumeCode` is a conditional `UPDATE`, not a read-then-write. Single-use is the
 * entire security property of a recovery code, and only the database can enforce it: two
 * concurrent verifications of the same code would both read `consumed_at IS NULL` and both
 * decide they were the winner.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import type { IDomainEvent } from '@auth/ddd-core';
import type { RecoveryCodeSetRepositoryPort } from '../../domain/ports/recovery-code-set-repository.port';
import {
  RecoveryCodeSet,
  type RecoveryCodeSetRow,
} from '../../domain/recovery-code-set.aggregate';
import { MFA_PRISMA } from '../../mfa.config';
import type { PrismaClient } from '../../generated/prisma/client';
import { enqueueEvents } from './outbox-enqueue';

const WITH_CODES = { mfa_recovery_codes: true } as const;

@Injectable()
export class PrismaRecoveryCodeSetRepository implements RecoveryCodeSetRepositoryPort {
  private readonly logger = new Logger(PrismaRecoveryCodeSetRepository.name);

  constructor(@Inject(MFA_PRISMA) private readonly prisma: PrismaService<PrismaClient>) {}

  /**
   * Installs `set` as the user's only set, discarding whatever was there.
   *
   * @remarks The delete is ordered before the insert because `user_id` is unique — that
   * constraint is what makes "the user's set" singular, so a rotation that inserted first
   * would fail on every regeneration.
   */
  async replace(set: RecoveryCodeSet): Promise<void> {
    const events = set.clearDomainEvents();

    if (this.prisma.inTransaction) {
      await this.write(set, events);
      return;
    }
    await this.prisma.runInTransaction((client) => this.write(set, events, client));
  }

  private async write(
    set: RecoveryCodeSet,
    events: readonly IDomainEvent[],
    client: PrismaClient = this.prisma.tx,
  ): Promise<void> {
    // Cascade takes the previous generation's rows with it. Nothing merges, and that is the
    // whole meaning of "regenerating invalidates the previous set": a merge would leave every
    // code an attacker had photographed still working.
    await client.mfa_recovery_code_sets.deleteMany({ where: { user_id: set.userId } });

    await client.mfa_recovery_code_sets.create({
      data: {
        set_id: set.id,
        user_id: set.userId,
        salt: set.salt,
        created_at: set.issuedAt,
        regenerated_at: set.regeneratedAt,
        mfa_recovery_codes: {
          create: set.entries().map((entry) => ({
            code_index: entry.index,
            // Only the digest. The table has no column for the plaintext, which is the
            // structural reason a stored row cannot be turned back into a usable code.
            digest: entry.digest,
            consumed_at: entry.consumedAt,
          })),
        },
      },
    });

    await enqueueEvents(client, events, {
      logger: this.logger,
      // Recovery codes partition by user: every event about one person's codes belongs on one
      // partition, so a consumer sees them in the order they happened.
      partitionKey: () => set.userId,
    });
  }

  /**
   * Persists spend markers and publishes the pending events.
   *
   * @remarks Only the rows whose marker actually moved are touched. The set's generation is
   * untouched by definition here — a spend must not be able to look like a rotation.
   */
  async save(set: RecoveryCodeSet): Promise<void> {
    const events = set.clearDomainEvents();

    if (this.prisma.inTransaction) {
      await this.writeMarkers(set, events);
      return;
    }
    await this.prisma.runInTransaction((client) => this.writeMarkers(set, events, client));
  }

  private async writeMarkers(
    set: RecoveryCodeSet,
    events: readonly IDomainEvent[],
    client: PrismaClient = this.prisma.tx,
  ): Promise<void> {
    for (const entry of set.entries()) {
      if (entry.consumedAt === null) continue;
      await client.mfa_recovery_codes.updateMany({
        where: { set_id: set.id, code_index: entry.index },
        data: { consumed_at: entry.consumedAt },
      });
    }

    await enqueueEvents(client, events, {
      logger: this.logger,
      partitionKey: () => set.userId,
    });
  }

  async findByUser(userId: string): Promise<RecoveryCodeSet | null> {
    const row = await this.prisma.tx.mfa_recovery_code_sets.findUnique({
      where: { user_id: userId },
      include: WITH_CODES,
    });
    return row ? RecoveryCodeSet.fromRow(row as unknown as RecoveryCodeSetRow) : null;
  }

  /**
   * Spends one code with a compare-and-set.
   *
   * @remarks `count === 1` is the only honest answer available under concurrency: if another
   * request spent this code between the read and the write, the update matches zero rows and
   * this one reports `false` rather than claiming a success it did not have.
   */
  async consumeCode(setId: string, codeIndex: number, now: Date): Promise<boolean> {
    const result = await this.prisma.tx.mfa_recovery_codes.updateMany({
      where: { set_id: setId, code_index: codeIndex, consumed_at: null },
      data: { consumed_at: now },
    });
    return result.count === 1;
  }
}