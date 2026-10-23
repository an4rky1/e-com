/**
 * @fileoverview The transaction boundary.
 *
 * @remarks Present because one command here touches more than one table — a verification
 * writes `mfa_factors`, `totp_used_counters`, possibly `mfa_recovery_codes` and the outbox —
 * and "all of it or none of it" is the difference between replay protection that works and
 * replay protection that can be skipped by a crash between two writes.
 *
 * @remarks The callback takes no client. Prisma's interactive transactions hand the ambient
 * client to a callback rather than returning one, so repositories join the transaction by
 * reading the ambient client themselves; passing it around would be the wrong shape for this
 * client and would leak a persistence type into the domain.
 *
 * @remarks Nesting is refused by the infrastructure implementation, which is deliberate: a
 * nested `$transaction` silently opens a second transaction with its own commit point, and the
 * guarantee this interface exists to provide would quietly stop holding.
 */

import type { IClock, IUnitOfWork } from '@auth/core';

export const MFA_UNIT_OF_WORK = Symbol('MFA_UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');

export type MfaUnitOfWork = IUnitOfWork;

/**
 * The clock.
 *
 * @remarks Re-declared as a token so the application layer depends on this module's own
 * contract. Injecting time rather than reading it is what makes "a code from 40 seconds ago is
 * refused" a unit test rather than a flaky integration test.
 */
export type MfaClock = IClock;