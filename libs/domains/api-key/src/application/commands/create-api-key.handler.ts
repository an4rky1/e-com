import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  ResourceAlreadyExistsException,
  ValidationException,
} from '@auth/platform/error-handling';
import { ApiKey } from '../../domain/api-key.aggregate';
import {
  API_KEY_CRYPTO,
  type ApiKeyCryptoPort,
} from '../../domain/ports/api-key-crypto.port';
import {
  API_KEY_REPOSITORY,
  type ApiKeyRepositoryPort,
} from '../../domain/ports/api-key-repository.port';
import { isApiKeyPrefix } from '../../domain/value-objects/api-key-prefix.vo';
import {
  API_KEY_SCOPES,
  isApiKeyScope,
} from '../../domain/value-objects/api-key-scope.vo';
import { API_KEY_CONFIG } from '../../api-key.config';
import type { ApiKeyConfig } from '../../api-key.config';
import { CreateApiKeyCommand, type CreatedApiKey } from './api-key.command';

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 64;

/**
 * The single write path for issuing a key.
 *
 * @remarks Commands are the only place mutations happen, so authorisation, auditing and event
 * publication have exactly one hook rather than one per entry point.
 */
@Injectable()
@CommandHandler(CreateApiKeyCommand)
export class CreateApiKeyHandler
  implements ICommandHandler<CreateApiKeyCommand, CreatedApiKey>
{
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepositoryPort,
    @Inject(API_KEY_CRYPTO) private readonly crypto: ApiKeyCryptoPort,
    @Inject(API_KEY_CONFIG) private readonly config: ApiKeyConfig,
  ) {}

  async execute(command: CreateApiKeyCommand): Promise<CreatedApiKey> {
    const name = command.name?.trim() ?? '';
    if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
      // A caller's mistake, so a 400 rather than a 500.
      throw new ValidationException(
        `name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`,
        {
          name: name.slice(0, MAX_NAME_LENGTH),
        },
      );
    }

    const family = command.family ?? this.config.keyFamily;
    if (!isApiKeyPrefix(family)) {
      throw new ValidationException('key family must be "live" or "test"', { family });
    }

    // Checked here as well as in the aggregate, so the caller gets a 400 that names the bad
    // scope instead of an untranslated `DomainError`. The aggregate keeps the rule; this is the
    // same rule said in the transport's language.
    if (command.scopes?.some((scope) => !isApiKeyScope(scope))) {
      throw new ValidationException('unknown api key scope', {
        expected: [...API_KEY_SCOPES],
        received: command.scopes.filter((scope) => !isApiKeyScope(scope)),
      });
    }

    // Checked before the insert so the common case returns a clean 409, rather than relying
    // on the unique index to surface a driver-level error code.
    if (await this.keys.existsByName(command.userId, name)) {
      throw new ResourceAlreadyExistsException('a key with this name already exists', {
        name,
      });
    }

    const now = new Date();
    const expiresAt = this.resolveExpiry(command.expiresAt, now);

    // The only place a plaintext key exists.
    const material = this.crypto.issueMaterial(family);

    const key = ApiKey.issue({
      userId: command.userId,
      name,
      material,
      scopes: command.scopes,
      expiresAt,
      now,
    });

    // The repository writes the row and its `api_key.created` event in one transaction.
    await this.keys.save(key);

    return {
      apiKeyId: key.id.value,
      userId: key.userId,
      name: key.name,
      prefix: key.prefix,
      key: material.secret.value,
      scopes: key.scopes,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    };
  }

  /**
   * Turns the requested deadline into a stored one.
   *
   * @remarks Three outcomes, and the third is the interesting one: a deadline in the past is
   * refused rather than stored. Accepting it would issue a key that has already expired — a
   * credential the caller can never use and cannot understand why.
   */
  private resolveExpiry(requested: Date | null | undefined, now: Date): Date | null {
    const ceiling = new Date(now.getTime() + this.config.maxTtlSec * 1_000);

    if (requested === undefined || requested === null) {
      return new Date(now.getTime() + this.config.defaultTtlSec * 1_000);
    }

    if (Number.isNaN(requested.getTime()) || requested.getTime() <= now.getTime()) {
      throw new ValidationException('expiresAt must be in the future', {
        expiresAt: requested.toISOString(),
      });
    }

    if (requested.getTime() > ceiling.getTime()) {
      throw new ValidationException('expiresAt exceeds the maximum lifetime', {
        maxTtlSec: this.config.maxTtlSec,
      });
    }

    return requested;
  }
}