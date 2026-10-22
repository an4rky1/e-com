/**
 * @fileoverview The api key aggregate: issue, rotate, revoke.
 *
 * @remarks This service answers one question — "is this request carrying a valid machine
 * credential, and what may it do?" — so it authenticates *machines*, never people. There is
 * no password here, no login flow, and no session: a password belongs to credential-vault and
 * a browser session to session-token, each behind a gRPC call. Holding any of that here would
 * make "what may this request do" inseparable from "who this person is".
 *
 * @remarks The plaintext key is returned exactly once, by the issue and rotate paths, and is
 * never a property of the aggregate. What the aggregate keeps is a SHA-256 digest and a
 * non-secret `prefix`; the secret exists only in the command result, long enough to be shown
 * once and then forgotten.
 */
import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/ddd-core';
import { ApiKeyId } from './value-objects/api-key-id.vo';
import {
  composePrefix,
  readPrefixFamily,
  type ApiKeyPrefix,
} from './value-objects/api-key-prefix.vo';
import {
  API_KEY_SCOPES,
  type ApiKeyScope,
  normaliseScopes,
  sanitiseScopes,
  satisfiesScopes,
} from './value-objects/api-key-scope.vo';
import { ApiKeyStatus, USABLE_STATUSES } from './value-objects/api-key-status.vo';
import type { IssuedApiKeyMaterial } from './value-objects/api-key-secret.vo';

/** Aggregate/event identity constants — the prefix that scopes every api key event. */
export const API_KEY_AGGREGATE = 'ApiKey';

/** Written to `revoke_reason` when a key was superseded by a rotation rather than dropped. */
export const ROTATED_REVOKE_REASON = 'rotated';

/**
 * Carried on `api_key.created`.
 *
 * @remarks `prefix`, never the key: this payload is written to `outbox_events`, fanned out to
 * every consumer and retained for as long as the audit trail lives. A credential that reaches
 * a topic is a credential that has to be treated as compromised.
 */
export interface ApiKeyCreatedPayload {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly family: ApiKeyPrefix;
  readonly scopes: readonly ApiKeyScope[];
  readonly expiresAt: string | null;
}

export interface ApiKeyRotatedPayload {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly prefix: string;
  readonly family: ApiKeyPrefix;
  /** The key this one supersedes. */
  readonly previousApiKeyId: string;
  readonly previousPrefix: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly expiresAt: string | null;
}

export interface ApiKeyRevokedPayload {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly prefix: string;
  readonly reason: string;
  readonly revokedAt: string;
}

export class ApiKeyCreated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: ApiKeyCreatedPayload,
    version = 1,
  ) {
    super(aggregateId, API_KEY_AGGREGATE, 'api_key.created', version);
  }
}

export class ApiKeyRotated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: ApiKeyRotatedPayload,
    version = 1,
  ) {
    super(aggregateId, API_KEY_AGGREGATE, 'api_key.rotated', version);
  }
}

export class ApiKeyRevoked extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: ApiKeyRevokedPayload,
    version = 1,
  ) {
    super(aggregateId, API_KEY_AGGREGATE, 'api_key.revoked', version);
  }
}

export interface ApiKeyProps {
  userId: string;
  name: string;
  /** `<family>_<random>`; unique, non-secret, and the only thing a presented key is looked up by. */
  prefix: string;
  /** Hex SHA-256 of the plaintext key. The plaintext itself is never stored. */
  secretHash: string;
  scopes: ApiKeyScope[];
  status: ApiKeyStatus;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  /** The key this one supersedes. `null` for a key issued from scratch. */
  rotatedFromId: string | null;
  /** How many rotations stand between the original issue and this key. */
  rotationCount: number;
  revokedAt: Date | null;
  revokeReason: string | null;
  /** Position in the event stream. Not a row column; there is no optimistic lock on this table. */
  version: number;
}

/** The result of a rotation: the key that stopped working and the one that replaced it. */
export interface ApiKeyRotation {
  readonly revoked: ApiKey;
  readonly successor: ApiKey;
}

/**
 * One `api_keys` row, exactly as the column names spell it.
 *
 * @remarks Declared here rather than in the repository so `fromRow` and `toRow` agree by
 * construction, and so an in-memory double in a test can be built without importing Prisma:
 * the domain must not know the transport, but it can know the shape of its own storage.
 */
export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  scopes: string[];
  status: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  rotated_from_id: string | null;
  rotation_count: number;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

/**
 * One machine credential.
 *
 * @remarks The aggregate is the consistency boundary for the credential *and* its event.
 * That matters most during rotation, which changes two rows: the new key is useless until the
 * old one stops working, and the old one is a live credential until it does. Persisting them
 * separately would leave a window with two working keys — or, the other way round, none.
 */
export class ApiKey extends AggregateRoot<ApiKeyId> {
  private constructor(
    id: ApiKeyId,
    private readonly props: ApiKeyProps,
    createdAt: Date,
  ) {
    super(id, createdAt, createdAt, null);
  }

  /**
   * Issues a key from freshly generated material.
   *
   * @remarks Lifetimes are arguments rather than configuration read here: the domain decides
   * *how long a credential may live* from policy the caller supplies, so a test can issue a
   * one-second key without touching the clock or the environment.
   *
   * @remarks `rotatedFrom` decides which fact is recorded. A key issued from scratch is an
   * `api_key.created`; a key issued to supersede another is an `api_key.rotated` carrying its
   * predecessor. Emitting `created` on both paths would leave consumers unable to tell a
   * fresh key from a replacement, and rotation is the event an operator has to be able to
   * alert on.
   */
  static issue(input: {
    userId: string;
    name: string;
    material: IssuedApiKeyMaterial;
    scopes?: readonly string[];
    expiresAt?: Date | null;
    /** The key this one supersedes. `null`/absent for a key issued from scratch. */
    rotatedFrom?: { readonly apiKeyId: string; readonly prefix: string };
    rotationCount?: number;
    id?: string;
    now?: Date;
  }): ApiKey {
    Ensure.notEmpty(input.userId, 'userId');
    Ensure.notEmpty(input.name, 'name');

    const now = input.now ?? new Date();
    const id = ApiKeyId.create(input.id);

    const key = new ApiKey(
      id,
      {
        userId: input.userId,
        name: input.name.trim(),
        prefix: input.material.prefix,
        secretHash: input.material.digest,
        scopes: normaliseScopes(input.scopes),
        status: ApiKeyStatus.ACTIVE,
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        rotatedFromId: input.rotatedFrom?.apiKeyId ?? null,
        rotationCount: input.rotationCount ?? 0,
        revokedAt: null,
        revokeReason: null,
        version: 1,
      },
      now,
    );

    const scopes = [...key.props.scopes];
    const expiresAt = key.props.expiresAt?.toISOString() ?? null;

    if (input.rotatedFrom) {
      key.addDomainEvent(
        new ApiKeyRotated(
          id.value,
          {
            apiKeyId: id.value,
            userId: input.userId,
            prefix: key.props.prefix,
            family: key.family,
            previousApiKeyId: input.rotatedFrom.apiKeyId,
            previousPrefix: input.rotatedFrom.prefix,
            scopes,
            expiresAt,
          },
          key.props.version,
        ),
      );
    } else {
      key.addDomainEvent(
        new ApiKeyCreated(
          id.value,
          {
            apiKeyId: id.value,
            userId: input.userId,
            name: key.props.name,
            prefix: key.props.prefix,
            family: key.family,
            scopes,
            expiresAt,
          },
          key.props.version,
        ),
      );
    }

    return key;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: ApiKeyRow): ApiKey {
    return new ApiKey(
      ApiKeyId.fromStored(row.id),
      {
        userId: row.user_id,
        name: row.name,
        prefix: row.prefix,
        secretHash: row.secret_hash,
        // Sanitised rather than validated: a row written by a *newer* build may carry a scope
        // this one does not know, and refusing to load it would turn a routine rollout into
        // an outage of the whole service. An unknown scope is dropped, never upgraded.
        scopes: sanitiseScopes(row.scopes),
        status: row.status as ApiKeyStatus,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        rotatedFromId: row.rotated_from_id,
        rotationCount: row.rotation_count,
        revokedAt: row.revoked_at,
        revokeReason: row.revoke_reason,
        // Zero because it is not a column: the position in this key's event stream is not
        // persisted, so a rehydrated key starts counting from its next transition.
        version: 0,
      },
      row.created_at,
    );
  }

  /** The same aggregate, flattened the way persistence hands it back. */
  toRow(): ApiKeyRow {
    return {
      id: this.id.value,
      user_id: this.props.userId,
      name: this.props.name,
      prefix: this.props.prefix,
      secret_hash: this.props.secretHash,
      scopes: [...this.props.scopes],
      status: this.props.status,
      created_at: this.createdAt,
      expires_at: this.props.expiresAt,
      last_used_at: this.props.lastUsedAt,
      rotated_from_id: this.props.rotatedFromId,
      rotation_count: this.props.rotationCount,
      revoked_at: this.props.revokedAt,
      revoke_reason: this.props.revokeReason,
    };
  }

  get userId(): string {
    return this.props.userId;
  }

  get name(): string {
    return this.props.name;
  }

  get prefix(): string {
    return this.props.prefix;
  }

  /** Never the plaintext: nothing can read a usable credential out of a loaded row. */
  get secretHash(): string {
    return this.props.secretHash;
  }

  get scopes(): readonly ApiKeyScope[] {
    return this.props.scopes;
  }

  get status(): ApiKeyStatus {
    return this.props.status;
  }

  get expiresAt(): Date | null {
    return this.props.expiresAt;
  }

  get lastUsedAt(): Date | null {
    return this.props.lastUsedAt;
  }

  get rotatedFromId(): string | null {
    return this.props.rotatedFromId;
  }

  get rotationCount(): number {
    return this.props.rotationCount;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get revokeReason(): string | null {
    return this.props.revokeReason;
  }

  /** `live` or `test`, read back off the prefix. */
  get family(): ApiKeyPrefix {
    return readPrefixFamily(this.props.prefix) ?? 'live';
  }

  /**
   * Position in this key's event stream.
   *
   * @remarks Shadows `AggregateRoot.version`, which counts *buffered* events and therefore
   * reads `0` immediately after `clearDomainEvents()` — which would make two different events
   * share a `dedup_key` and the second one be silently swallowed as a duplicate.
   */
  override get version(): number {
    return this.props.version;
  }

  isExpiredAt(now: Date = new Date()): boolean {
    return (
      this.props.expiresAt !== null && this.props.expiresAt.getTime() <= now.getTime()
    );
  }

  get isActive(): boolean {
    return USABLE_STATUSES.has(this.props.status);
  }

  /**
   * The one question authentication asks.
   *
   * @remarks Expiry is checked here rather than materialised into `status`, so a key stops
   * working the instant its deadline passes without a sweeper having to notice that it did.
   * `status === 'revoked'` is checked first: a revoked key says *revoked* even after its
   * deadline has also passed, because "we withdrew this" is the more useful of the two
   * answers to an operator staring at an audit trail.
   */
  isUsableAt(now: Date = new Date()): boolean {
    if (!this.isActive) return false;
    return !this.isExpiredAt(now);
  }

  /** Whether the key's own scopes cover a requirement. `admin` covers everything. */
  satisfies(required: readonly ApiKeyScope[]): boolean {
    return satisfiesScopes(this.props.scopes, required);
  }

  hasScope(scope: ApiKeyScope): boolean {
    return satisfiesScopes(this.props.scopes, [scope]);
  }

  /**
   * Records that the key was just used.
   *
   * @remarks Emits no domain event: "the key still works" is not a fact any consumer needs,
   * and an event per authenticated request would bury `api_key.revoked` in noise. For the
   * same reason it does not bump `version` either — an unauthenticated request must not be
   * able to move a key's position in its own event stream.
   */
  markUsed(now: Date = new Date()): void {
    if (this.props.status !== ApiKeyStatus.ACTIVE) return;
    if (this.props.lastUsedAt?.getTime() === now.getTime()) return;
    this.props.lastUsedAt = now;
    this.updatedAt = now;
  }

  /**
   * Withdraws the key.
   *
   * @remarks Idempotent: revocation is retried by every operator tooling that queues a
   * "disable this key" job, and a second call must not emit a second `api_key.revoked` for a
   * fact already published — the `dedup_key` would collide, but only by accident.
   */
  revoke(reason: string, now: Date = new Date()): void {
    if (this.props.status === ApiKeyStatus.REVOKED) return;

    this.props.status = ApiKeyStatus.REVOKED;
    this.props.revokedAt = now;
    this.props.revokeReason = reason;
    this.bump(now);

    this.addDomainEvent(
      new ApiKeyRevoked(
        this.id.value,
        {
          apiKeyId: this.id.value,
          userId: this.props.userId,
          prefix: this.props.prefix,
          reason,
          revokedAt: now.toISOString(),
        },
        this.props.version,
      ),
    );
  }

  /**
   * Supersedes this key with a new one, in a single step.
   *
   * @remarks A static rather than an instance method because it spans two aggregates: one root
   * must never mutate another, and "the new key is useless until the old one stops working"
   * is a rule about the pair, not about either of them.
   *
   * @remarks The order is revoke-then-issue. Issuing first would leave two live credentials
   * for the length of a transaction, and a rotation is exactly the moment a leak is assumed.
   *
   * @returns both sides, so the caller can persist them in one transaction and observe either
   * one alone.
   */
  static rotate(input: {
    current: ApiKey;
    material: IssuedApiKeyMaterial;
    expiresAt?: Date | null;
    now?: Date;
  }): ApiKeyRotation {
    const now = input.now ?? new Date();
    const previous = input.current;

    Ensure.isTrue(
      previous.isActive,
      `api key is ${previous.status} and cannot be rotated`,
      'CONFLICTING_STATE',
    );

    previous.revoke(ROTATED_REVOKE_REASON, now);

    const successor = ApiKey.issue({
      userId: previous.userId,
      // The name carries over so the owner sees one key in their list, not two, and so the
      // `(user_id, name)` unique index is satisfied without a rename dance.
      name: previous.name,
      material: input.material,
      scopes: previous.scopes,
      // The family deadline is a hard stop, not a rolling window: a rotated key that outlived
      // the original's lifetime would let a continuously-rotated leaked key live forever.
      expiresAt: input.expiresAt ?? previous.expiresAt,
      rotatedFrom: { apiKeyId: previous.id.value, prefix: previous.prefix },
      rotationCount: previous.rotationCount + 1,
      now,
    });

    return { revoked: previous, successor };
  }

  /** Every mutation goes through here, so `version` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

export type ApiKeyEvent = ApiKeyCreated | ApiKeyRotated | ApiKeyRevoked;

export const isApiKeyEvent = (event: IDomainEvent): event is ApiKeyEvent =>
  event.aggregateType === API_KEY_AGGREGATE;

/** The prefixes a stored row's scopes can contain, re-exported so callers validate once. */
export { API_KEY_SCOPES, composePrefix };