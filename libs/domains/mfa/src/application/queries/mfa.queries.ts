/**
 * @fileoverview The single read model this service exposes.
 *
 * @remarks One query, answering "what second factors does this person hold, and can they
 * satisfy one right now?" Both halves are needed by the same caller — auth-flow deciding
 * whether to challenge — and two round trips would race with each other: the status could
 * say "active" while the factor was being disabled a millisecond later.
 *
 * @remarks Nothing here carries a secret, a pending envelope or a spent step. The response is
 * an advertisement of the account's MFA posture, and a caller who could read the envelope out
 * of it would not need to guess a code.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { MfaStatus } from '../../domain/value-objects/mfa-status.vo';
import {
  MFA_FACTOR_REPOSITORY,
  type MfaFactorRepositoryPort,
} from '../../domain/ports/mfa-factor-repository.port';
import {
  RECOVERY_CODE_SET_REPOSITORY,
  type RecoveryCodeSetRepositoryPort,
} from '../../domain/ports/recovery-code-set-repository.port';
import { toFactorSummary, type MfaFactorSummary } from '../commands/mfa.commands';

/** One factor's public state. */
export interface MfaFactorStatus extends MfaFactorSummary {
  /** Whether this factor can satisfy a verification *right now*. */
  readonly verifiable: boolean;
}

export interface MfaRecoveryCodeStatus {
  readonly total: number;
  readonly remaining: number;
  readonly issuedAt: string;
  readonly regeneratedAt: string | null;
}

export interface MfaStatusReadModel {
  readonly userId: string;
  /** Whether a live second factor exists at all — the question the gateway actually asks. */
  readonly enrolled: boolean;
  readonly factors: readonly MfaFactorStatus[];
  readonly activeFactorId: string | null;
  /** Set while the user has an unconfirmed enrollment, so the UI can resume it. */
  readonly pendingFactorId: string | null;
  readonly recoveryCodes: MfaRecoveryCodeStatus | null;
  /** The soonest lockout in force, if any. */
  readonly lockedUntil: string | null;
}

export class GetMfaStatusQuery extends Query<MfaStatusReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly userId: string) {
    super();
  }
}

@Injectable()
@QueryHandler(GetMfaStatusQuery)
export class GetMfaStatusHandler
  implements IQueryHandler<GetMfaStatusQuery, MfaStatusReadModel>
{
  constructor(
    @Inject(MFA_FACTOR_REPOSITORY) private readonly factors: MfaFactorRepositoryPort,
    @Inject(RECOVERY_CODE_SET_REPOSITORY) private readonly sets: RecoveryCodeSetRepositoryPort,
  ) {}

  async execute(query: GetMfaStatusQuery): Promise<MfaStatusReadModel> {
    const [factors, set] = await Promise.all([
      this.factors.findByUser(query.userId),
      this.sets.findByUser(query.userId),
    ]);

    const statuses = factors.map((factor) => ({
      ...toFactorSummary(factor),
      // The aggregate's own predicate, not a `status === 'active'` re-implementation here: one
      // definition of "can satisfy a verification" is the property being defended.
      verifiable: factor.canSatisfyVerification,
    }));

    const active = factors.find((factor) => factor.canSatisfyVerification) ?? null;
    const pending = factors.find((factor) => factor.status === MfaStatus.PENDING) ?? null;
    const lockedUntil = statuses
      .map((factor) => factor.lockedUntil)
      .filter((value): value is string => value !== null)
      .sort()
      .at(0);

    return {
      userId: query.userId,
      enrolled: active !== null,
      factors: statuses,
      activeFactorId: active?.id ?? null,
      pendingFactorId: pending?.id ?? null,
      recoveryCodes: set
        ? {
            total: set.codeCount,
            remaining: set.remaining,
            issuedAt: set.issuedAt.toISOString(),
            regeneratedAt: set.regeneratedAt?.toISOString() ?? null,
          }
        : null,
      lockedUntil: lockedUntil ?? null,
    };
  }
}