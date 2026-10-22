import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  PermissionDeniedException,
  ResourceNotFoundException,
} from '@auth/platform/error-handling';
import {
  API_KEY_REPOSITORY,
  type ApiKeyRepositoryPort,
} from '../../domain/ports/api-key-repository.port';
import { ApiKeyStatus } from '../../domain/value-objects/api-key-status.vo';
import { RevokeApiKeyCommand, type RevokedApiKey } from './api-key.command';

/**
 * Withdraws a key.
 *
 * @remarks Revocation is a record, not a deletion: the row stays, because "this key was
 * withdrawn on the 3rd, by an operator, after an incident" is a question the audit trail has to
 * be able to answer.
 */
@Injectable()
@CommandHandler(RevokeApiKeyCommand)
export class RevokeApiKeyHandler
  implements ICommandHandler<RevokeApiKeyCommand, RevokedApiKey>
{
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepositoryPort,
  ) {}

  async execute(command: RevokeApiKeyCommand): Promise<RevokedApiKey> {
    const key = await this.keys.findById(command.apiKeyId);

    if (!key) {
      throw new ResourceNotFoundException('api key not found', { apiKeyId: command.apiKeyId });
    }

    // The owner check is here rather than in the aggregate so a key belonging to somebody else
    // and a key that does not exist can be reported differently: both are decisions about *this
    // request's* authorisation, and neither reveals anything about the credential itself.
    if (command.userId !== undefined && key.userId !== command.userId) {
      throw new PermissionDeniedException('api key belongs to another user');
    }

    const now = new Date();
    // Read before the transition: `revoke()` is idempotent, so afterwards every key looks
    // revoked and a retried command would report a change it never made.
    const wasRevoked = key.status === ApiKeyStatus.REVOKED;

    key.revoke(command.reason, now);

    if (!wasRevoked) {
      await this.keys.save(key);
    }

    return {
      apiKeyId: key.id.value,
      userId: key.userId,
      reason: wasRevoked ? (key.revokeReason ?? command.reason) : command.reason,
      revokedAt: key.revokedAt ?? now,
      changed: !wasRevoked,
    };
  }
}