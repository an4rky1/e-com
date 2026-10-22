/**
 * @fileoverview Prisma-backed {@link MfaUnitOfWork}.
 *
 * @remarks Thin by design. The value of the unit of work is not this class but the rule it
 * lets the application layer follow: *one command, one transaction*. A verification writes
 * `mfa_factors`, `totp_used_counters`, possibly `mfa_recovery_codes` and the outbox, and
 * "all of it or none of it" is the difference between replay protection that holds and replay
 * protection that can be skipped by a crash between two writes.
 *
 * @remarks Nesting is refused by {@link PrismaService.runInTransaction} itself, which is
 * deliberate: a nested `$transaction` opens a *second* transaction with its own commit point,
 * and the guarantee this port exists to provide would quietly stop holding.
 */

import { Inject, Injectable } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import {
  MFA_UNIT_OF_WORK,
  type MfaUnitOfWork,
} from '../../domain/ports/mfa-unit-of-work.port';
import { MFA_PRISMA } from '../../mfa.config';
import type { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaMfaUnitOfWork implements MfaUnitOfWork {
  constructor(@Inject(MFA_PRISMA) private readonly prisma: PrismaService<PrismaClient>) {}

  runInTransaction<TResult>(fn: () => Promise<TResult>): Promise<TResult> {
    // The callback takes no client: Prisma's interactive transactions make the client
    // ambient, and repositories read it back through `prisma.tx`. Passing it around would leak
    // a persistence type into the domain and would invite a repository to open its own.
    return this.prisma.runInTransaction(async () => fn());
  }

  isActive(): boolean {
    return this.prisma.inTransaction;
  }
}

export { MFA_UNIT_OF_WORK };