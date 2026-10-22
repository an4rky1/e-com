/**
 * @fileoverview What an owner sees in their list of keys.
 *
 * @remarks Like every query in this workspace it is a class: `QueryBus.execute` resolves a
 * handler from `query.constructor`, and `@QueryHandler('Name')` throws at import because
 * `Reflect.hasOwnMetadata` rejects a non-object.
 *
 * @remarks The read model carries no `secret_hash`, and that absence is the design. A listing is
 * the surface most likely to be logged, cached and rendered, and a digest on it would put one
 * more copy of a credential-adjacent value into every system that touches the response.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import {
  API_KEY_REPOSITORY,
  type ApiKeyRepositoryPort,
} from '../../domain/ports/api-key-repository.port';
import type { ApiKey } from '../../domain/api-key.aggregate';
import type { ApiKeyPrefix } from '../../domain/value-objects/api-key-prefix.vo';
import type { ApiKeyScope } from '../../domain/value-objects/api-key-scope.vo';
import type { ApiKeyStatus } from '../../domain/value-objects/api-key-status.vo';

/**
 * One row of the owner's key list.
 *
 * @remarks `usable` is evaluated, not stored: it is `status` *and* the deadline as of `now`, and
 * a value frozen at write time would still be showing a key as live the request after it
 * expired. Revoked keys are included — an owner who has withdrawn a key needs to see it — which
 * is why `usable` exists as a separate fact rather than being inferred from `status`.
 */
export interface ApiKeySummary {
  readonly apiKeyId: string;
  readonly name: string;
  /** `<family>_<random>`: safe to display, useless for authenticating with. */
  readonly prefix: string;
  readonly family: ApiKeyPrefix;
  readonly scopes: readonly ApiKeyScope[];
  readonly status: ApiKeyStatus;
  readonly usable: boolean;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly rotatedFromId: string | null;
  readonly rotationCount: number;
  readonly createdAt: Date;
}

export const toApiKeySummary = (key: ApiKey, now: Date = new Date()): ApiKeySummary => ({
  apiKeyId: key.id.value,
  name: key.name,
  prefix: key.prefix,
  family: key.family,
  scopes: key.scopes,
  status: key.status,
  usable: key.isUsableAt(now),
  expiresAt: key.expiresAt,
  lastUsedAt: key.lastUsedAt,
  revokedAt: key.revokedAt,
  rotatedFromId: key.rotatedFromId,
  rotationCount: key.rotationCount,
  createdAt: key.createdAt,
});

/**
 * Every key a user holds.
 *
 * @remarks Filtered by owner rather than by usability: the list is the dashboard behind "your
 * API keys", and a dashboard that silently drops the keys you revoked cannot answer "did my
 * revocation take effect?".
 */
export class ListUserApiKeysQuery extends Query<ApiKeySummary[]> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    /** `false` narrows to keys that still authenticate, for a quick "what works?" view. */
    readonly usableOnly = false,
    readonly now?: Date,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(ListUserApiKeysQuery)
export class ListUserApiKeysHandler
  implements IQueryHandler<ListUserApiKeysQuery, ApiKeySummary[]>
{
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepositoryPort,
  ) {}

  async execute(query: ListUserApiKeysQuery): Promise<ApiKeySummary[]> {
    const now = query.now ?? new Date();
    const owned = await this.keys.findByUser(query.userId);

    return owned
      .filter((key) => !query.usableOnly || key.isUsableAt(now))
      .map((key) => toApiKeySummary(key, now));
  }
}