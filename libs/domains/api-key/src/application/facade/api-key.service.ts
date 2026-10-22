import { Inject, Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  CreateApiKeyCommand,
  RevokeApiKeyCommand,
  RotateApiKeyCommand,
  type CreatedApiKey,
  type RevokedApiKey,
  type RotatedApiKey,
} from '../commands/api-key.command';
import {
  ListUserApiKeysQuery,
  type ApiKeySummary,
} from '../queries/api-key.queries';
import type { ApiKeyScope } from '../../domain/value-objects/api-key-scope.vo';

/**
 * The only public surface of the api-key module.
 *
 * @remarks api-gateway — the one caller, over gRPC or HTTP — depends on this class and nothing
 * else. It therefore cannot reach the repository, the CQRS bus or the aggregate, which is what
 * makes this module's internals replaceable without touching a single caller.
 *
 * @remarks `createKey` and `rotateKey` return the plaintext key, and these two methods are the
 * only place in the service where a plaintext exists after issue. Anything that wanted to log a
 * command result would be logging a live credential.
 */
@Injectable()
export class ApiKeyService {
  constructor(
    // Explicit tokens rather than relying on `design:paramtypes`: a type-only import is erased
    // before the decorator metadata is emitted, so the parameter would arrive as `Object` and
    // the container would have nothing to resolve it against.
    @Inject(CommandBus) private readonly commandBus: CommandBus,
    @Inject(QueryBus) private readonly queryBus: QueryBus,
  ) {}

  /** The key in `result.key` is shown once and never again. */
  createKey(input: {
    userId: string;
    name: string;
    scopes?: readonly ApiKeyScope[];
    expiresAt?: Date | null;
    family?: 'live' | 'test';
  }): Promise<CreatedApiKey> {
    return this.commandBus.execute(
      new CreateApiKeyCommand(
        input.userId,
        input.name,
        input.scopes,
        input.expiresAt,
        input.family,
      ),
    );
  }

  /** Issues a successor and revokes the original in the same transaction. */
  rotateKey(input: {
    apiKeyId: string;
    family?: 'live' | 'test';
    expiresAt?: Date | null;
  }): Promise<RotatedApiKey> {
    return this.commandBus.execute(
      new RotateApiKeyCommand(input.apiKeyId, input.family, input.expiresAt),
    );
  }

  revokeKey(input: {
    apiKeyId: string;
    reason?: string;
    userId?: string;
  }): Promise<RevokedApiKey> {
    return this.commandBus.execute(
      new RevokeApiKeyCommand(input.apiKeyId, input.reason ?? 'revoked_by_owner', input.userId),
    );
  }

  listUserKeys(input: {
    userId: string;
    usableOnly?: boolean;
    now?: Date;
  }): Promise<ApiKeySummary[]> {
    return this.queryBus.execute(
      new ListUserApiKeysQuery(input.userId, input.usableOnly ?? false, input.now),
    );
  }
}

/**
 * Re-exported so a caller can build a scope list from the module's public surface alone.
 *
 * @remarks The *type*, not a second definition: a copy of the union written out here would be a
 * list that drifts from the one the aggregate validates against, and the drift would only show
 * up as a 400 from a command at runtime.
 */
export type { ApiKeyScope };