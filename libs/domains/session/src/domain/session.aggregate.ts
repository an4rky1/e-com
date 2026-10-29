import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/core';
import type {
  SessionIssuedPayload,
  SessionReuseDetectedPayload,
  SessionRevokedPayload,
} from '@auth/contracts';
import { IssuedRefreshToken, type NewRefreshToken } from './refresh-token.entity';
import { SessionRuleViolation, SessionRefusal } from './session.errors';
import { SessionId } from './value-objects/session-id.vo';
import { TokenFamilyId } from './value-objects/token-family-id.vo';
import { SessionStatus, TERMINAL_STATUSES, USABLE_STATUSES } from './value-objects/session-status.vo';
import { TokenStatus } from './value-objects/token-status.vo';

/** Aggregate/event identity constants — the prefix that scopes every session event. */
export const SESSION_AGGREGATE = 'Session';

/** Written to `sessions.revoke_reason` so a revoked session says *why* without a lookup. */
export const REUSE_REVOKE_REASON = 'refresh_token_reuse';

/** Written when a session is retired because its lifetime ran out. */
export const EXPIRED_REVOKE_REASON = 'expired';

/**
 * A session was issued — the pair went out with it.
 *
 * @remarks The payload is the `SessionIssuedPayload` contract verbatim: the aggregate already
 * speaks the integration contract's language, so the outbox does not have to re-translate it
 * and cannot drift from what consumers already handle.
 */
export class SessionIssued extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: SessionIssuedPayload,
    version = 1,
  ) {
    super(aggregateId, SESSION_AGGREGATE, 'session.issued', version);
  }
}

/**
 * A refresh token was exchanged.
 *
 * @remarks Carries the family id because a rotation chain is the unit an investigation
 * actually walks: knowing which login a stolen token descends from is what turns "revoke this
 * session" into "revoke everything this device obtained".
 */
export class SessionRefreshed extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      readonly sessionId: string;
      readonly userId: string;
      readonly tokenFamilyId: string;
      readonly rotatedTokenId: string;
      readonly issuedTokenId: string;
    },
    version = 1,
  ) {
    super(aggregateId, SESSION_AGGREGATE, 'session.refreshed', version);
  }
}

/**
 * A session stopped being usable.
 *
 * @remarks Emitted for expiry as well as revocation. The topic catalogue has no
 * `session.expired`, and to a consumer the two are the same fact — a credential that can no
 * longer be used — with the reason carried in the payload. A second event type on the same
 * topic would mean two payload shapes for one subscription.
 */
export class SessionRevoked extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: SessionRevokedPayload,
    version = 1,
  ) {
    super(aggregateId, SESSION_AGGREGATE, 'session.revoked', version);
  }
}

/**
 * A consumed refresh token was presented again.
 *
 * @remarks The most serious event this service emits. It means two parties hold the same
 * refresh token, so the only safe response is to revoke the whole family — and the event is
 * what tells account-security that it happened.
 */
export class SessionReuseDetected extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: SessionReuseDetectedPayload & {
      readonly tokenFamilyId: string;
      readonly presentedTokenId: string;
    },
    version = 1,
  ) {
    super(aggregateId, SESSION_AGGREGATE, 'session.token_reuse_detected', version);
  }
}

export interface SessionProps {
  userId: string;
  tokenFamilyId: TokenFamilyId;
  deviceId: string | null;
  status: SessionStatus;
  issuedAt: Date;
  expiresAt: Date;
  refreshExpiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  clientIp: string | null;
  userAgent: string | null;
  version: number;
  refreshTokens: IssuedRefreshToken[];
}

/**
 * One login, on one device, with the chain of refresh tokens descended from it.
 *
 * @remarks Session-token owns *what was issued and whether it still counts*. It never decides
 * who the user is — identity does — which is why the user id, the email and the role list are
 * plain claims carried through rather than anything this service looks up.
 *
 * The aggregate is also the consistency boundary for its refresh tokens. Rotation consumes
 * one token and issues its successor in a single step: there is no window in which both are
 * live, and no window in which neither is.
 */
export class Session extends AggregateRoot<SessionId> {
  private constructor(
    id: SessionId,
    private readonly props: SessionProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * Opens a session and issues its first refresh token.
   *
   * @remarks Lifetimes are arguments rather than configuration read here: the domain decides
   * *how long a credential may live* from policy the caller supplies, so a test can run a
   * one-second session without touching the clock.
   */
  static issue(input: {
    userId: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    refreshToken: NewRefreshToken;
    sessionId?: string;
    tokenFamilyId?: string;
    deviceId?: string | null;
    clientIp?: string | null;
    userAgent?: string | null;
    now?: Date;
  }): Session {
    Ensure.notEmpty(input.userId, 'userId');
    Ensure.positive(input.accessTokenTtlSec, 'accessTokenTtlSec');
    Ensure.positive(input.refreshTokenTtlSec, 'refreshTokenTtlSec');
    // A refresh window shorter than the access-token lifetime would mint a refresh token
    // that is already dead on arrival.
    Ensure.isTrue(
      input.refreshTokenTtlSec > input.accessTokenTtlSec,
      'refresh token lifetime must outlast the access token',
    );

    const now = input.now ?? new Date();
    const id = SessionId.create(input.sessionId);
    const familyId = TokenFamilyId.create(input.tokenFamilyId);

    const token = IssuedRefreshToken.issue({
      id: input.refreshToken.id,
      familyId: familyId.value,
      token: input.refreshToken.token,
      jti: input.refreshToken.jti,
      expiresAt: new Date(now.getTime() + input.refreshTokenTtlSec * 1_000),
      now,
    });

    const session = new Session(
      id,
      {
        userId: input.userId,
        tokenFamilyId: familyId,
        deviceId: input.deviceId ?? null,
        status: SessionStatus.ACTIVE,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + input.accessTokenTtlSec * 1_000),
        refreshExpiresAt: token.expiresAt,
        revokedAt: null,
        revokeReason: null,
        clientIp: input.clientIp ?? null,
        userAgent: input.userAgent ?? null,
        version: 1,
        refreshTokens: [token],
      },
      now,
      now,
    );

    session.addDomainEvent(
      new SessionIssued(
        id.value,
        {
          sessionId: id.value,
          userId: input.userId,
          deviceId: session.props.deviceId ?? undefined,
          ipAddress: session.props.clientIp ?? undefined,
        },
        1,
      ),
    );

    return session;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: {
    id: string;
    user_id: string;
    token_family_id: string;
    device_id: string | null;
    status: string;
    issued_at: Date;
    expires_at: Date;
    refresh_expires_at: Date;
    revoked_at: Date | null;
    revoke_reason: string | null;
    client_ip: string | null;
    user_agent: string | null;
    version: number;
    created_at: Date;
    updated_at: Date;
    refresh_tokens: Parameters<typeof IssuedRefreshToken.fromRow>[0][];
  }): Session {
    return new Session(
      SessionId.fromStored(row.id),
      {
        userId: row.user_id,
        tokenFamilyId: TokenFamilyId.fromStored(row.token_family_id),
        deviceId: row.device_id,
        status: row.status as SessionStatus,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        refreshExpiresAt: row.refresh_expires_at,
        revokedAt: row.revoked_at,
        revokeReason: row.revoke_reason,
        clientIp: row.client_ip,
        userAgent: row.user_agent,
        version: row.version,
        refreshTokens: row.refresh_tokens.map(IssuedRefreshToken.fromRow),
      },
      row.created_at,
      row.updated_at,
    );
  }

  get userId(): string {
    return this.props.userId;
  }

  get tokenFamilyId(): TokenFamilyId {
    return this.props.tokenFamilyId;
  }

  get deviceId(): string | null {
    return this.props.deviceId;
  }

  get status(): SessionStatus {
    return this.props.status;
  }

  get issuedAt(): Date {
    return this.props.issuedAt;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get refreshExpiresAt(): Date {
    return this.props.refreshExpiresAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get revokeReason(): string | null {
    return this.props.revokeReason;
  }

  get clientIp(): string | null {
    return this.props.clientIp;
  }

  get userAgent(): string | null {
    return this.props.userAgent;
  }

  get refreshTokens(): readonly IssuedRefreshToken[] {
    return this.props.refreshTokens;
  }

  /**
   * The row version, as persisted.
   *
   * @remarks Shadows `AggregateRoot.version`, which counts *buffered* events and therefore
   * reads `0` immediately after `clearDomainEvents()` — the wrong number to write to a
   * `version` column. Every mutation goes through {@link bump}, so this one and the event
   * stream cannot drift apart.
   */
  override get version(): number {
    return this.props.version;
  }

  /** The one token that may currently be exchanged, if there is one. */
  get activeRefreshToken(): IssuedRefreshToken | null {
    return (
      [...this.props.refreshTokens]
        .reverse()
        .find((token) => token.status === TokenStatus.ACTIVE) ?? null
    );
  }

  isExpiredAt(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  isRefreshExpiredAt(now: Date): boolean {
    return this.props.refreshExpiresAt.getTime() <= now.getTime();
  }

  get isActive(): boolean {
    return USABLE_STATUSES.has(this.props.status);
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.props.status);
  }

  findRefreshToken(id: string): IssuedRefreshToken | null {
    return this.props.refreshTokens.find((token) => token.id === id) ?? null;
  }

  findRefreshTokenByDigest(digest: string): IssuedRefreshToken | null {
    return this.props.refreshTokens.find((token) => token.digest === digest) ?? null;
  }

  /**
   * Exchanges a refresh token for a fresh pair.
   *
   * @remarks Consuming the old token and issuing the new one is one step, in this order: a
   * failure between them would leave a refresh token that is live but points nowhere.
   *
   * @returns the newly issued token record, so the caller can read its expiry without
   * reaching into the aggregate's internals.
   */
  rotate(input: {
    presentedTokenId: string;
    next: NewRefreshToken;
    now?: Date;
  }): IssuedRefreshToken {
    const now = input.now ?? new Date();
    this.assertRotatable(now);

    const presented = this.findRefreshToken(input.presentedTokenId);
    if (!presented) {
      throw new SessionRuleViolation(
        SessionRefusal.REFRESH_TOKEN_UNKNOWN,
        'refresh token does not belong to this session',
        { sessionId: this.id.value },
      );
    }

    // Defensive: the caller is expected to route a replayed token through
    // {@link detectRefreshTokenReuse}, which revokes the family. Refusing here rather than
    // rotating means a caller that forgets still cannot re-open a consumed token — it gets an
    // error instead of a working session.
    if (presented.isConsumed()) {
      throw new SessionRuleViolation(
        SessionRefusal.REFRESH_TOKEN_REPLAYED,
        'refresh token has already been used',
        { sessionId: this.id.value, tokenId: presented.id },
      );
    }

    if (presented.isExpired(now)) {
      throw new SessionRuleViolation(
        SessionRefusal.REFRESH_TOKEN_EXPIRED,
        'refresh token has expired',
        { sessionId: this.id.value, tokenId: presented.id },
      );
    }

    const next = IssuedRefreshToken.issue({
      id: input.next.id,
      familyId: this.props.tokenFamilyId.value,
      token: input.next.token,
      jti: input.next.jti,
      // The family's refresh deadline is a hard stop, not a rolling window: a rotated token
      // that outlived its session's refresh lifetime would let a continuously-used stolen
      // token live forever.
      expiresAt: this.props.refreshExpiresAt,
      now,
    });

    presented.rotateTo(next.id, now);
    this.props.refreshTokens.push(next);
    this.bump(now);

    this.addDomainEvent(
      new SessionRefreshed(
        this.id.value,
        {
          sessionId: this.id.value,
          userId: this.props.userId,
          tokenFamilyId: this.props.tokenFamilyId.value,
          rotatedTokenId: presented.id,
          issuedTokenId: next.id,
        },
        this.props.version,
      ),
    );

    return next;
  }

  /**
   * Withdraws the session and every token it ever issued.
   *
   * @remarks Idempotent: logout is retried by every client that has a queued sign-out, and a
   * second call must not emit a second `session.revoked` for a fact already published.
   */
  revoke(reason: string, now: Date = new Date(), allSessions = false): void {
    if (this.props.status === SessionStatus.REVOKED) return;

    this.props.status = SessionStatus.REVOKED;
    this.props.revokedAt = now;
    this.props.revokeReason = reason;

    for (const token of this.props.refreshTokens) {
      token.revoke(now);
    }

    this.bump(now);
    this.addDomainEvent(
      new SessionRevoked(
        this.id.value,
        {
          sessionId: this.id.value,
          userId: this.props.userId,
          reason,
          allSessions,
        },
        this.props.version,
      ),
    );
  }

  /**
   * Retires a session whose lifetime has run out.
   *
   * @remarks Separate from {@link revoke} because the outcome differs: an expired session has
   * no `revoked_at` and no attacker to investigate, and writing "revoked" would make every
   * expiry look like a security event.
   */
  expire(now: Date = new Date()): void {
    if (this.props.status !== SessionStatus.ACTIVE) return;

    this.props.status = SessionStatus.EXPIRED;
    this.props.revokeReason = EXPIRED_REVOKE_REASON;

    for (const token of this.props.refreshTokens) {
      token.revoke(now);
    }

    this.bump(now);
    // Published as a revocation with `reason: 'expired'` — see {@link SessionRevoked}.
    this.addDomainEvent(
      new SessionRevoked(
        this.id.value,
        {
          sessionId: this.id.value,
          userId: this.props.userId,
          reason: EXPIRED_REVOKE_REASON,
          allSessions: false,
        },
        this.props.version,
      ),
    );
  }

  /**
   * Reacts to a consumed refresh token being presented again.
   *
   * @remarks Marks *this* session and raises the reuse event. It does not touch the rest of
   * the family — that is {@link revokeFamilyOnReuse}'s job, and it can only be done by a
   * caller that has actually loaded the family.
   *
   * @remarks No exception is thrown here on purpose. The revocations have to be persisted
   * before the caller reports the reuse; throwing from inside the transaction would roll back
   * the very revocations that are the point of the detection.
   */
  detectRefreshTokenReuse(input: {
    presentedTokenId: string;
    familySize: number;
    now?: Date;
  }): void {
    const now = input.now ?? new Date();
    const presented = this.findRefreshToken(input.presentedTokenId);

    if (!presented) {
      throw new SessionRuleViolation(
        SessionRefusal.REFRESH_TOKEN_UNKNOWN,
        'refresh token does not belong to this session',
        { sessionId: this.id.value },
      );
    }
    if (!presented.isConsumed()) {
      throw new SessionRuleViolation(
        SessionRefusal.REFRESH_TOKEN_NOT_REPLAYED,
        'refresh token is still active, so this is not reuse',
        { sessionId: this.id.value, tokenId: presented.id },
      );
    }

    // Even an already-revoked session re-announces the reuse: the row's events were cleared
    // by an earlier save, and the security signal must not be lost to a repeat presentation.
    if (this.props.status === SessionStatus.ACTIVE) {
      this.props.status = SessionStatus.REVOKED;
      this.props.revokedAt = now;
      this.props.revokeReason = REUSE_REVOKE_REASON;
      for (const token of this.props.refreshTokens) {
        token.revoke(now);
      }
      this.bump(now);

      // Announced on *both* topics: the reuse topic tells account-security that a token was
      // stolen, the revoked topic tells every consumer with a cached session that this one is
      // finished. Two types, one version — the dedup key includes the event type, so neither
      // can swallow the other.
      this.addDomainEvent(
        new SessionRevoked(
          this.id.value,
          {
            sessionId: this.id.value,
            userId: this.props.userId,
            reason: REUSE_REVOKE_REASON,
            allSessions: false,
          },
          this.props.version,
        ),
      );
    }

    this.addDomainEvent(
      new SessionReuseDetected(
        this.id.value,
        {
          sessionId: this.id.value,
          userId: this.props.userId,
          tokenFamilyId: this.props.tokenFamilyId.value,
          presentedTokenId: presented.id,
          revokedCount: input.familySize,
          ipAddress: this.props.clientIp ?? undefined,
        },
        this.props.version,
      ),
    );
  }

  /**
   * Revokes every session in a family after a replay.
   *
   * @remarks A free function on the aggregate rather than an instance method: a family spans
   * sessions, and one root must never mutate another.
   *
   * @remarks Sessions that were already revoked are still returned, so their pending events
   * are flushed — but re-announcing reuse is limited to `ownerSessionId`, otherwise N sessions
   * would emit N identical security events for one replay.
   */
  static revokeFamilyOnReuse(input: {
    sessions: readonly Session[];
    tokenFamilyId: TokenFamilyId;
    /** The session whose consumed token was presented. */
    ownerSessionId: string;
    presentedTokenId: string;
    now?: Date;
  }): Session[] {
    const now = input.now ?? new Date();
    const family = input.sessions.filter((session) =>
      session.tokenFamilyId.equals(input.tokenFamilyId),
    );

    for (const session of family) {
      if (session.id.value === input.ownerSessionId) {
        session.detectRefreshTokenReuse({
          presentedTokenId: input.presentedTokenId,
          familySize: family.length,
          now,
        });
      } else {
        session.revoke(REUSE_REVOKE_REASON, now);
      }
    }

    return family;
  }

  /**
   * Revokes every session except the caller's own.
   *
   * @remarks "Sign out everywhere else" is the reason `exceptSessionId` exists: a user
   * revoking a lost device must not be signed out of the browser they are using to do it.
   * Sessions that are already terminal are left alone, so the caller gets a count of what
   * actually changed rather than of what it looked at.
   */
  static revokeAllExcept(
    sessions: readonly Session[],
    exceptSessionId: string | null,
    reason: string,
    now: Date = new Date(),
  ): Session[] {
    const revoked: Session[] = [];

    for (const session of sessions) {
      if (exceptSessionId !== null && session.id.value === exceptSessionId) continue;
      if (session.status === SessionStatus.REVOKED) continue;

      session.revoke(reason, now, true);
      revoked.push(session);
    }

    return revoked;
  }

  /** Every mutation goes through here, so `version` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }

  /**
   * The guards a rotation has to pass.
   *
   * @remarks Status is checked before the clock so a revoked session reports *revoked* rather
   * than "expired" — the caller can act on the difference, and an attacker replaying a token
   * from a revoked session learns nothing about its lifetime.
   */
  private assertRotatable(now: Date): void {
    if (!this.isActive) {
      throw new SessionRuleViolation(
        SessionRefusal.SESSION_NOT_ACTIVE,
        `session is ${this.props.status} and cannot be rotated`,
        { sessionId: this.id.value, status: this.props.status },
      );
    }
    if (this.isExpiredAt(now)) {
      throw new SessionRuleViolation(
        SessionRefusal.SESSION_EXPIRED,
        'session has expired',
        { sessionId: this.id.value, expiresAt: this.props.expiresAt.toISOString() },
      );
    }
    if (this.isRefreshExpiredAt(now)) {
      throw new SessionRuleViolation(
        SessionRefusal.REFRESH_TOKEN_EXPIRED,
        'refresh token lifetime has ended for this session',
        { sessionId: this.id.value, refreshExpiresAt: this.props.refreshExpiresAt.toISOString() },
      );
    }
  }
}

export type SessionEvent =
  | SessionIssued
  | SessionRefreshed
  | SessionRevoked
  | SessionReuseDetected;

export const isSessionEvent = (event: IDomainEvent): event is SessionEvent =>
  event.aggregateType === SESSION_AGGREGATE;