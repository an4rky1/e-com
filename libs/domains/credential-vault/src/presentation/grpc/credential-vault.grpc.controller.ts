/**
 * @fileoverview gRPC transport for credential-vault.
 *
 * @remarks "Prove you are this user" is a question with an answer — true or false — rather
 * than a resource to fetch, so it is a synchronous gRPC call instead of an event. Every other
 * service depends on this surface instead of reading the database, which is what keeps
 * `credential_vault` private to this service.
 */
import { Controller } from '@nestjs/common';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import { InvalidCredentialsException } from '@auth/platform/error-handling';
import type {
  SetPasswordRequest,
  SetPasswordResponse,
  VerifyPasswordRequest,
  VerifyPasswordResponse,
} from '@auth/contracts';
// Value import: constructor-injected facade. `emitDecoratorMetadata` reads the value
// binding, so a type-only import leaves Nest with `Object` and no resolvable token.
import { CredentialVaultService } from '../../application/facade/credential-vault.service';

const SERVICE = 'CredentialVaultService';

/**
 * `RevokeAllCredentialsRequest` / `Response`, spelled out here.
 *
 * @remarks `libs/contracts/src/grpc/service-contracts.ts` declares this pair inline on
 * `CredentialVaultGrpcClient` rather than exporting named interfaces, so there is nothing to
 * import. Duplicating two field names is cheaper than a type-only import of an anonymous
 * shape, and this file stays the single place a drift would show up.
 */
interface RevokeAllCredentialsRequest {
  userId: string;
  reason: string;
}

interface RevokeAllCredentialsResponse {
  revokedCount: number;
}

/**
 * gRPC transport for credential-vault, implementing `CredentialVaultGrpcClient` server-side.
 *
 * @remarks It extends {@link GrpcControllerBase} so that the service-token guard reaches this
 * port: `VerifyPassword` is the call a wrong caller would most want to make, and without the
 * base it is open to anything that can reach the address.
 */
@Controller()
export class CredentialVaultGrpcController extends GrpcControllerBase {
  constructor(private readonly vault: CredentialVaultService) {
    super();
  }

  /**
   * Answers "is this the right password?".
   *
   * @remarks A refusal comes back as `valid: false`, not as a gRPC error, because the proto
   * models the answer as a field — and because an error carries a status a caller could
   * branch on in a way that turns "no such user" into a distinguishable outcome.
   *
   * @remarks `failedAttempts` is reported as zero on every refusal. The real counter is
   * published on the `credential.failed` topic, which is where account-security reads it from:
   * a caller who is refused must not be handed a number that differs between "unknown user"
   * and "wrong password", or the indistinguishability this endpoint works to preserve is gone
   * one field from the end.
   */
  @GrpcMethod(SERVICE, 'VerifyPassword')
  async verifyPassword(request: VerifyPasswordRequest): Promise<VerifyPasswordResponse> {
    try {
      const result = await this.vault.verifyPassword({
        userId: request.userId,
        password: request.password,
        allowRehash: request.allowRehash,
      });

      return {
        valid: true,
        // The hash was already upgraded inside the command when it was stale, so there is
        // nothing left for the caller to act on.
        needsRehash: false,
        failedAttempts: result.failedAttempts,
      };
    } catch (error) {
      if (error instanceof InvalidCredentialsException) {
        return { valid: false, needsRehash: false, failedAttempts: 0 };
      }
      throw error;
    }
  }

  /**
   * Sets or replaces a password.
   *
   * @remarks Provisioning, not proof of possession: the caller has already authorised the
   * change by other means. A rotation that must be driven by the owner alone goes through
   * `ChangePasswordCommand`, which is not on this surface.
   */
  @GrpcMethod(SERVICE, 'SetPassword')
  async setPassword(request: SetPasswordRequest): Promise<SetPasswordResponse> {
    const credentialId = await this.vault.setPassword({
      userId: request.userId,
      newPassword: request.newPassword,
    });

    return { ok: true, credentialId };
  }

  @GrpcMethod(SERVICE, 'RevokeAllCredentials')
  async revokeAllCredentials(
    request: RevokeAllCredentialsRequest,
  ): Promise<RevokeAllCredentialsResponse> {
    const { revokedCount } = await this.vault.revokeAllCredentials({
      userId: request.userId,
      reason: request.reason,
    });

    return { revokedCount };
  }
}