/**
 * @fileoverview The only public surface of the MFA module.
 *
 * @remarks Controllers, the auth-flow guard and other services depend on this class and
 * nothing else. They therefore cannot reach the repository, the CQRS bus, the vault or the
 * aggregate — which is what makes this service's internals replaceable without touching a
 * single caller.
 *
 * @remarks Also the adapter that satisfies {@link MfaChallengePort}: the guard needs to ask
 * "does this code prove possession of a second factor?", and routing that question through
 * the command bus keeps the guard free of any knowledge about factors, secrets or lockouts.
 */

import { Injectable } from '@nestjs/common';
// Value import, not `import type`: these are constructor-injected, and
// `emitDecoratorMetadata` reads the emitted value binding to resolve them.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { isMfaDomainError } from '../../domain/errors/mfa-domain.error';
import {
  ConfirmEnrollmentCommand,
  DisableMfaCommand,
  RegenerateRecoveryCodesCommand,
  VerifyFactorCommand,
  toBeginEnrollmentCommand,
  type EnrollmentSecretBundle,
  type FactorVerificationResult,
  type MfaFactorSummary,
  type RecoveryCodeBundle,
} from '../commands/mfa.commands';
import {
  GetMfaStatusQuery,
  type MfaStatusReadModel,
} from '../queries/mfa.queries';
import type { MfaChallengePort } from '../../domain/ports/mfa-challenge.port';
import type { MfaMethod } from '../../domain/value-objects/mfa-method.vo';

@Injectable()
export class MfaService implements MfaChallengePort {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  beginEnrollment(input: {
    userId: string;
    method?: MfaMethod;
    accountLabel?: string | null;
    destinationHint?: string | null;
  }): Promise<EnrollmentSecretBundle> {
    return this.commandBus.execute<EnrollmentSecretBundle>(
      toBeginEnrollmentCommand(input),
    );
  }

  confirmEnrollment(input: {
    userId: string;
    factorId: string;
    code: string;
  }): Promise<MfaFactorSummary> {
    return this.commandBus.execute<MfaFactorSummary>(
      new ConfirmEnrollmentCommand(input.userId, input.factorId, input.code),
    );
  }

  verifyFactor(input: {
    userId: string;
    code: string;
    method?: MfaMethod;
    factorId?: string;
  }): Promise<FactorVerificationResult> {
    return this.commandBus.execute<FactorVerificationResult>(
      new VerifyFactorCommand(input.userId, input.code, input.method ?? 'totp', input.factorId),
    );
  }

  disableMfa(input: { userId: string; factorId: string; code: string }): Promise<void> {
    return this.commandBus.execute<void>(
      new DisableMfaCommand(input.userId, input.factorId, input.code),
    );
  }

  regenerateRecoveryCodes(input: {
    userId: string;
    count?: number;
  }): Promise<RecoveryCodeBundle> {
    return this.commandBus.execute<RecoveryCodeBundle>(
      new RegenerateRecoveryCodesCommand(input.userId, input.count),
    );
  }

  getStatus(userId: string): Promise<MfaStatusReadModel> {
    return this.queryBus.execute(new GetMfaStatusQuery(userId));
  }

  /**
   * The guard's question: does this code prove possession of a second factor?
   *
   * @remarks Answers `false` rather than throwing. The guard has to render one refusal —
   * "second factor required" — for a wrong code, an unconfirmed factor and a lockout alike,
   * and letting a typed exception through would make the response shape a function of *why*
   * the code failed. That difference is exactly what an attacker enumerates.
   */
  async verifyOwnership(input: { userId: string; code: string }): Promise<boolean> {
    try {
      const result = await this.verifyFactor({ userId: input.userId, code: input.code });
      return result.verifiedAt.length > 0;
    } catch (error) {
      if (isMfaDomainError(error)) return false;
      throw error;
    }
  }
}