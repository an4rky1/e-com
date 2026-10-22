/**
 * @fileoverview The PasswordCredential aggregate.
 *
 * @remarks This service answers one question — "prove you are this user" — and this aggregate
 * is everything that question needs. It never asks whether the account exists, whether it is
 * suspended or whether its email is verified: those are identity's facts, reached over gRPC.
 * A credential row that could answer them would make the two inseparable, and every sign-in
 * would become a cross-database join.
 */
import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/ddd-core';
import type {
  CredentialFailedPayload,
  CredentialVerifiedPayload,
} from '@auth/contracts';
import {
  type HashParameters,
  type PasswordHash,
  type PasswordHasherPort,
} from './ports/password-hasher.port';
import { CredentialId } from './value-objects/credential-id.vo';
import {
  CredentialMethod,
  CredentialStatus,
  TERMINAL_STATUSES,
  VERIFIABLE_STATUSES,
} from './value-objects/credential-status.vo';

/** Aggregate/event identity constants — the prefix that scopes every credential event. */
export const CREDENTIAL_AGGREGATE = 'PasswordCredential';

/** Identifier written when the caller does not supply one. */
export const DEFAULT_CREDENTIAL_IDENTIFIER = 'password';

/** Why a credential stopped being usable, when no caller-supplied reason applies. */
export const FAILED_ATTEMPTS_LOCK_REASON = 'failed_attempts';

/**
 * What changed about the stored secret.
 *
 * @remarks Part of the event payload rather than a second event type: every one of these is
 * the same fact to a consumer — "whatever secret this credential had, it does not have it
 * any more" — and the outbox would otherwise publish four payload shapes on one topic.
 */
export const CredentialRotation = {
  /** First password for a credential that had none. */
  SET: 'set',
  /** Owner-supplied change, proven with the previous password. */
  CHANGED: 'changed',
  /** Transparent upgrade of a hash made under weaker Argon2 parameters. */
  REHASHED: 'rehashed',
} as const;

export type CredentialRotation = (typeof CredentialRotation)[keyof typeof CredentialRotation];

/** How many wrong passwords a credential tolerates, and for how long it then refuses. */
export interface LockoutPolicy {
  maxFailedAttempts: number;
  lockoutSec: number;
}

/** A password was accepted. */
export class CredentialVerified extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: CredentialVerifiedPayload & { readonly credentialId: string },
    version = 1,
  ) {
    super(aggregateId, CREDENTIAL_AGGREGATE, 'credential.verified', version);
  }
}

/**
 * A password was rejected.
 *
 * @remarks The most heavily consumed event this service emits: it is how account-security
 * learns that an address is being guessed at, and how the lockout becomes observable at all.
 */
export class CredentialFailed extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: CredentialFailedPayload & { readonly credentialId: string },
    version = 1,
  ) {
    super(aggregateId, CREDENTIAL_AGGREGATE, 'credential.failed', version);
  }
}

/** The stored secret was replaced, or upgraded in place. */
export class CredentialRotated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      readonly credentialId: string;
      readonly userId: string;
      readonly method: string;
      readonly rotation: CredentialRotation;
      /** True when a lock or failed-attempt counter was cleared by this rotation. */
      readonly clearedLock: boolean;
    },
    version = 1,
  ) {
    super(aggregateId, CREDENTIAL_AGGREGATE, 'credential.rotated', version);
  }
}

/**
 * The credential was retired.
 *
 * @remarks Emitted per credential, and the aggregate id is the *credential*, not the user, so
 * `revokeAll` over three credentials publishes three ordered events rather than one summary.
 * A consumer that wants the summary counts them.
 */
export class CredentialRevoked extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      readonly credentialId: string;
      readonly userId: string;
      readonly reason: string;
      readonly allCredentials: boolean;
    },
    version = 1,
  ) {
    super(aggregateId, CREDENTIAL_AGGREGATE, 'credential.revoked', version);
  }
}

export interface PasswordCredentialProps {
  userId: string;
  identifier: string;
  method: CredentialMethod;
  secretHash: string;
  hashParameters: HashParameters;
  status: CredentialStatus;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastVerifiedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  version: number;
}

export interface PasswordCredentialRow {
  id: string;
  user_id: string;
  identifier: string;
  method: string;
  secret_hash: string | null;
  secret_parameters: unknown;
  status: string;
  failed_attempts: number;
  locked_until: Date | null;
  last_verified_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export class PasswordCredential extends AggregateRoot<CredentialId> {
  private constructor(
    id: CredentialId,
    private readonly props: PasswordCredentialProps,
    private readonly hasher: PasswordHasherPort,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * Mints a credential around an already-computed hash.
   *
   * @remarks The hash arrives from the `PasswordHasherPort` rather than being computed
   * here: hashing is deliberately slow, and an aggregate constructor is a place where being
   * slow turns into a request timeout. The policy check belongs on the plaintext *before* it
   * is hashed, so a weak password is refused before anything worth storing exists.
   *
   * @remarks `hasher` travels with the aggregate. `needsRehash` is a question about the stored
   * hash *and* the current policy, and answering it anywhere else would split the answer from
   * the state it is about.
   *
   * @remarks The factory emits `credential.rotated`. Construction is a transition here, not the
   * absence of one: "a password now exists for this user" is exactly the fact account-security
   * and audit-log subscribe to, and a credential saved with an empty event buffer would make
   * a live first password unannounced. Rehydration is the other path — see {@link fromRow} —
   * which never emits, because that write already happened.
   */
  static create(input: {
    userId: string;
    hasher: PasswordHasherPort;
    hash: PasswordHash;
    identifier?: string;
    method?: CredentialMethod;
    id?: string;
    now?: Date;
  }): PasswordCredential {
    Ensure.notEmpty(input.userId, 'userId');
    Ensure.notEmpty(input.hash.digest, 'hash.digest');

    const now = input.now ?? new Date();

    const credential = new PasswordCredential(
      CredentialId.create(input.id),
      {
        userId: input.userId,
        identifier: input.identifier?.trim() || DEFAULT_CREDENTIAL_IDENTIFIER,
        method: input.method ?? CredentialMethod.PASSWORD,
        secretHash: input.hash.digest,
        hashParameters: input.hash.parameters,
        status: CredentialStatus.ACTIVE,
        failedAttempts: 0,
        lockedUntil: null,
        lastVerifiedAt: null,
        revokedAt: null,
        revokedReason: null,
        version: 1,
      },
      input.hasher,
      now,
      now,
    );

    // Version 1 without a bump: the row is written at version 1 and this is the event that
    // made it so, so the outbox `dedup_key` and the stored version agree.
    credential.addDomainEvent(
      new CredentialRotated(
        credential.id.value,
        {
          credentialId: credential.id.value,
          userId: credential.userId,
          method: credential.method,
          rotation: CredentialRotation.SET,
          clearedLock: false,
        },
        credential.version,
      ),
    );

    return credential;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(
    row: PasswordCredentialRow,
    hasher: PasswordHasherPort,
  ): PasswordCredential {
    return new PasswordCredential(
      CredentialId.fromStored(row.id),
      {
        userId: row.user_id,
        identifier: row.identifier,
        method: (row.method as CredentialMethod) ?? CredentialMethod.PASSWORD,
        secretHash: row.secret_hash ?? '',
        hashParameters: readHashParameters(row.secret_parameters, hasher.currentParameters),
        status: row.status as CredentialStatus,
        failedAttempts: row.failed_attempts,
        lockedUntil: row.locked_until,
        lastVerifiedAt: row.last_verified_at,
        revokedAt: row.revoked_at,
        revokedReason: row.revoked_reason,
        version: row.version,
      },
      hasher,
      row.created_at,
      row.updated_at,
    );
  }

  // ---- state -------------------------------------------------------------------

  /**
   * The stored hash's cost, not the event stream's.
   *
   * @remarks `AggregateRoot.version` derives from the buffered events, and a repository drains
   * that buffer *before* it reads the row — so the base getter would hand back `0` on every
   * save. This one is the counter the column actually stores.
   */
  override get version(): number {
    return this.props.version;
  }

  get userId(): string {
    return this.props.userId;
  }

  get identifier(): string {
    return this.props.identifier;
  }

  get method(): CredentialMethod {
    return this.props.method;
  }

  get status(): CredentialStatus {
    return this.props.status;
  }

  get failedAttempts(): number {
    return this.props.failedAttempts;
  }

  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }

  get lastVerifiedAt(): Date | null {
    return this.props.lastVerifiedAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get revokedReason(): string | null {
    return this.props.revokedReason;
  }

  get hashParameters(): HashParameters {
    return this.props.hashParameters;
  }

  /** Never the digest. A read model that carried it would leak it into every log it passed. */
  get hasSecret(): boolean {
    return this.props.secretHash.length > 0;
  }

  /**
   * The stored Argon2id digest.
   *
   * @remarks Public because the repository is the only thing that may have it — the same
   * trade `IssuedRefreshToken.digest` makes. It is deliberately not reachable from any read
   * model or response DTO, so the only way back to a plaintext is the pepper.
   */
  get digest(): string {
    return this.props.secretHash;
  }

  // ---- decisions ---------------------------------------------------------------

  /**
   * Whether a password may be checked against this credential right now.
   *
   * @remarks A lock that has expired stops being a lock on its own. Making the caller wait for
   * a sweeper to flip the column would mean a user who mistypes six passwords cannot sign in
   * until some background job runs.
   */
  isVerifiable(now: Date = new Date()): boolean {
    if (TERMINAL_STATUSES.has(this.props.status)) return false;
    return VERIFIABLE_STATUSES.has(this.props.status) || !this.isLocked(now);
  }

  isRevoked(): boolean {
    return TERMINAL_STATUSES.has(this.props.status);
  }

  isLocked(now: Date = new Date()): boolean {
    if (this.props.status !== CredentialStatus.LOCKED) return false;
    // A lock with no expiry is treated as permanent: failing open on a malformed row would
    // hand an attacker the credential that the row was supposed to protect.
    if (this.props.lockedUntil === null) return true;
    return this.props.lockedUntil > now;
  }

  /** Seconds until the lock lifts. Zero when it is not locked. */
  retryAfterSeconds(now: Date = new Date()): number {
    if (!this.isLocked(now) || this.props.lockedUntil === null) return 0;
    return Math.ceil((this.props.lockedUntil.getTime() - now.getTime()) / 1000);
  }

  /**
   * Whether the stored hash was made under weaker parameters than this service uses today.
   *
   * @remarks Checked *after* a successful verification and never before: rehashing on a
   * failure would spend an Argon2 budget on every guess an attacker makes, which is a denial
   * of service the attacker gets for free.
   */
  needsRehash(): boolean {
    if (!this.hasSecret) return false;
    return this.hasher.needsRehash(this.props.hashParameters);
  }

  // ---- transitions -------------------------------------------------------------

  /** Records an accepted password and clears whatever the last run of failures left behind. */
  recordVerification(now: Date = new Date()): void {
    Ensure.isTrue(
      !this.isRevoked(),
      'a revoked credential cannot be verified',
      'CONFLICTING_STATE',
    );

    this.props.lastVerifiedAt = now;
    this.props.failedAttempts = 0;
    this.props.lockedUntil = null;
    this.props.status = CredentialStatus.ACTIVE;

    this.bump(now);
    this.addDomainEvent(
      new CredentialVerified(
        this.id.value,
        {
          credentialId: this.id.value,
          userId: this.props.userId,
          method: this.props.method,
          rehashed: false,
        },
        this.props.version,
      ),
    );
  }

  /**
   * Records a rejected password, and locks the credential once the budget is spent.
   *
   * @remarks Always called, including for a credential that is already locked: incrementing
   * past the threshold is what keeps extending the lock while an attacker keeps guessing, and
   * the `credential.failed` stream is what makes the attack visible to account-security.
   */
  recordFailure(policy: LockoutPolicy, now: Date = new Date()): void {
    Ensure.isTrue(
      !this.isRevoked(),
      'a revoked credential cannot record failures',
      'CONFLICTING_STATE',
    );

    this.props.failedAttempts += 1;
    const locked = this.props.failedAttempts >= policy.maxFailedAttempts;
    if (locked) {
      this.props.status = CredentialStatus.LOCKED;
      this.props.lockedUntil = new Date(now.getTime() + policy.lockoutSec * 1000);
    }

    this.bump(now);
    this.addDomainEvent(
      new CredentialFailed(
        this.id.value,
        {
          credentialId: this.id.value,
          userId: this.props.userId,
          identifier: this.props.identifier,
          attempt: this.props.failedAttempts,
        },
        this.props.version,
      ),
    );
  }

  /**
   * Installs a new hash, resetting the failure counter and any lock.
   *
   * @remarks Refuses on a revoked credential rather than resurrecting it: revocation is a fact
   * other services have already been told about, and un-revoking a row would leave them acting
   * on stale information. A new secret means a new credential.
   */
  replaceSecret(
    hash: PasswordHash,
    rotation: CredentialRotation,
    now: Date = new Date(),
  ): void {
    Ensure.isTrue(
      !this.isRevoked(),
      'a revoked credential cannot take a new secret',
      'CONFLICTING_STATE',
    );

    const clearedLock =
      this.props.status === CredentialStatus.LOCKED || this.props.failedAttempts > 0;

    this.props.secretHash = hash.digest;
    this.props.hashParameters = hash.parameters;
    this.props.failedAttempts = 0;
    this.props.lockedUntil = null;
    this.props.status = CredentialStatus.ACTIVE;

    this.bump(now);
    this.addDomainEvent(
      new CredentialRotated(
        this.id.value,
        {
          credentialId: this.id.value,
          userId: this.props.userId,
          method: this.props.method,
          rotation,
          clearedLock,
        },
        this.props.version,
      ),
    );
  }

  /** Retires the credential. Idempotent: revoking twice is not two events. */
  revoke(reason: string, now: Date = new Date(), allCredentials = false): void {
    if (this.isRevoked()) return;

    this.props.status = CredentialStatus.REVOKED;
    this.props.revokedAt = now;
    this.props.revokedReason = reason;
    this.props.lockedUntil = null;

    this.bump(now);
    this.addDomainEvent(
      new CredentialRevoked(
        this.id.value,
        {
          credentialId: this.id.value,
          userId: this.props.userId,
          reason,
          allCredentials,
        },
        this.props.version,
      ),
    );
  }

  /** Every mutation goes through here, so `version` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

export type CredentialEvent =
  | CredentialVerified
  | CredentialFailed
  | CredentialRotated
  | CredentialRevoked;

export const isCredentialEvent = (event: IDomainEvent): event is CredentialEvent =>
  event.aggregateType === CREDENTIAL_AGGREGATE;

/**
 * Reads `secret_parameters` back into typed parameters.
 *
 * @remarks `unknown` rather than a cast: the column is JSON, so its contents are whatever
 * wrote them. A row whose parameters cannot be read falls back to the *current* policy, which
 * makes `needsRehash()` answer `false` and leaves the hash alone — upgrading is a decision
 * that needs real parameters, and guessing them could rehash a valid credential for nothing.
 */
function readHashParameters(raw: unknown, fallback: HashParameters): HashParameters {
  if (typeof raw !== 'object' || raw === null) return fallback;

  const candidate = raw as Partial<HashParameters>;
  const isPositiveInt = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;

  return {
    algorithm: 'argon2id',
    memoryCost: isPositiveInt(candidate.memoryCost) ? candidate.memoryCost : fallback.memoryCost,
    timeCost: isPositiveInt(candidate.timeCost) ? candidate.timeCost : fallback.timeCost,
    parallelism: isPositiveInt(candidate.parallelism) ? candidate.parallelism : fallback.parallelism,
    hashLength: isPositiveInt(candidate.hashLength) ? candidate.hashLength : fallback.hashLength,
    version: isPositiveInt(candidate.version) ? candidate.version : fallback.version,
  };
}