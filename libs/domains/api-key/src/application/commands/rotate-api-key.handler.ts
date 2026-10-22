import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  ResourceNotFoundException,
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
import {
  isApiKeyPrefix,
  readPrefixFamily,
  type ApiKeyPrefix,
} from '../../domain/value-objects/api-key-prefix.vo';
import { API_KEY_CONFIG, type ApiKeyConfig } from '../../api-key.config';
import { RotateApiKeyCommand, type RotatedApiKey } from './api-key.command';

/**
 * Replaces a key with a new one and stops the old one working.
 *
 * @remarks One command, two rows, one transaction — see {@link ApiKey.rotate} for why the pair
 * cannot be persisted separately. The handler's whole job is the bookkeeping around that call:
 * which family the successor belongs to, and what deadline it inherits.
 */
@Injectable()
@CommandHandler(RotateApiKeyCommand)
export class RotateApiKeyHandler
  implements ICommandHandler<RotateApiKeyCommand, RotatedApiKey>
{
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepositoryPort,
    @Inject(API_KEY_CRYPTO) private readonly crypto: ApiKeyCryptoPort,
    @Inject(API_KEY_CONFIG) private readonly config: ApiKeyConfig,
  ) {}

  async execute(command: RotateApiKeyCommand): Promise<RotatedApiKey> {
    const current = await this.keys.findById(command.apiKeyId);

    if (!current) {
      throw new ResourceNotFoundException('api key not found', { apiKeyId: command.apiKeyId });
    }

    const now = new Date();
    const family = this.resolveFamily(command.family, current.prefix);
    const material = this.crypto.issueMaterial(family);

    const { revoked, successor } = ApiKey.rotate({
      current,
      material,
      expiresAt: this.resolveSuccessorExpiry(command.expiresAt, current.expiresAt, now),
      now,
    });

    // One transaction: the old key must not outlive the moment the new one exists, and the new
    // key must not exist before the old one stops working.
    await this.keys.saveMany([revoked, successor]);

    return {
      apiKeyId: successor.id.value,
      userId: successor.userId,
      name: successor.name,
      prefix: successor.prefix,
      // The last time this secret is ever readable. It is not on the aggregate, so nothing
      // downstream of the command can log it by accident.
      key: material.secret.value,
      scopes: successor.scopes,
      expiresAt: successor.expiresAt,
      createdAt: successor.createdAt,
      previousApiKeyId: revoked.id.value,
      previousPrefix: revoked.prefix,
      revokedAt: revoked.revokedAt ?? now,
    };
  }

  /**
   * The family the successor is minted in.
   *
   * @remarks The original's family wins over configuration. A `live` deployment whose
   * configuration was edited to `test` mid-incident must not silently downgrade every key that
   * exists into one that staging would accept — the family travels *inside* the credential, and
   * a rotation should not change what a key is.
   */
  private resolveFamily(requested: string | undefined, currentPrefix: string): ApiKeyPrefix {
    const family = requested ?? readPrefixFamily(currentPrefix) ?? this.config.keyFamily;

    if (!isApiKeyPrefix(family)) {
      throw new ValidationException('key family must be "live" or "test"', { family });
    }

    return family;
  }

  /**
   * What deadline the successor gets.
   *
   * @remarks Three outcomes, and the second is the one that matters: a caller may shorten the
   * lifetime but not extend it beyond policy. When nothing is requested the successor inherits
   * the original's deadline — *unless* that deadline has already passed, in which case inheriting
   * it would mint a credential that is dead on arrival, which is worse than useless because the
   * owner sees a key in their list and cannot use it.
   */
  private resolveSuccessorExpiry(
    requested: Date | null | undefined,
    inherited: Date | null,
    now: Date,
  ): Date | null {
    if (requested !== undefined && requested !== null) {
      return this.assertWithinCeiling(requested, now);
    }

    if (inherited !== null && inherited.getTime() > now.getTime()) {
      return inherited;
    }

    return new Date(now.getTime() + this.config.defaultTtlSec * 1_000);
  }

  private assertWithinCeiling(requested: Date, now: Date): Date {
    if (Number.isNaN(requested.getTime()) || requested.getTime() <= now.getTime()) {
      throw new ValidationException('expiresAt must be in the future', {
        expiresAt: requested.toISOString(),
      });
    }

    const ceiling = now.getTime() + this.config.maxTtlSec * 1_000;
    if (requested.getTime() > ceiling) {
      throw new ValidationException('expiresAt exceeds the maximum lifetime', {
        maxTtlSec: this.config.maxTtlSec,
      });
    }

    return requested;
  }
}