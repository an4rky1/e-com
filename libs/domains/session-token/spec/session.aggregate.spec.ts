import {
  EXPIRED_REVOKE_REASON,
  REUSE_REVOKE_REASON,
  Session,
} from '../src/domain/session.aggregate';
import type {
  SessionIssued,
  SessionRevoked,
  SessionTokenReuseDetected,
  SessionTokensRefreshed,
} from '../src/domain/session.aggregate';
import { SessionRuleViolation, SessionRefusal } from '../src/domain/session.errors';
import { SessionStatus } from '../src/domain/value-objects/session-status.vo';
import { TokenStatus } from '../src/domain/value-objects/token-status.vo';
import { RefreshToken } from '../src/domain/value-objects/refresh-token.vo';
import { SessionId } from '../src/domain/value-objects/session-id.vo';

const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_USER = '9b2d5b7e-6b7e-4f3a-9b1a-2c3d4e5f6071';
const FAMILY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_FAMILY = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

const TTL = { accessTokenTtlSec: 900, refreshTokenTtlSec: 2_592_000 } as const;

const issue = (overrides: Partial<Parameters<typeof Session.issue>[0]> = {}) =>
  Session.issue({
    userId: USER,
    ...TTL,
    refreshToken: { token: RefreshToken.mint() },
    ...overrides,
  });

/** Runs `fn` and reports the refusal it raised, so a guard can be asserted by name. */
function refusalOf(fn: () => unknown): SessionRefusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof SessionRuleViolation) return error.refusal;
    throw error;
  }
  throw new Error('expected a SessionRuleViolation, but nothing was thrown');
}

describe('Session.issue', () => {
  it('starts active, with one usable refresh token and a family of its own', () => {
    const session = issue();

    expect(session.status).toBe(SessionStatus.ACTIVE);
    expect(session.isActive).toBe(true);
    expect(session.refreshTokens).toHaveLength(1);
    expect(session.activeRefreshToken?.status).toBe(TokenStatus.ACTIVE);
    // A fresh login starts its own chain: the family is what reuse detection widens later.
    expect(session.tokenFamilyId.value).not.toBe(session.id.value);
  });

  it('emits exactly one session.issued event carrying the aggregate id', () => {
    const session = issue({ deviceId: 'laptop-1', clientIp: '203.0.113.7' });

    const events = session.domainEvents;
    expect(events).toHaveLength(1);

    const [event] = events as SessionIssued[];
    expect(event.eventType).toBe('session.issued');
    expect(event.aggregateType).toBe('Session');
    expect(event.aggregateId).toBe(session.id.value);
    expect(event.payload).toMatchObject({
      sessionId: session.id.value,
      userId: USER,
      deviceId: 'laptop-1',
      ipAddress: '203.0.113.7',
    });
  });

  it('stores only the digest of the refresh token, never the token', () => {
    const token = RefreshToken.mint();
    const session = issue({ refreshToken: { token } });

    const [stored] = session.refreshTokens;
    expect(stored.digest).toHaveLength(64);
    expect(JSON.stringify(session.refreshTokens)).not.toContain(token.value);
  });

  it('refuses a refresh lifetime that does not outlast the access token', () => {
    // Otherwise the first refresh would return a token that is already dead.
    expect(() =>
      Session.issue({
        userId: USER,
        accessTokenTtlSec: 900,
        refreshTokenTtlSec: 900,
        refreshToken: { token: RefreshToken.mint() },
      }),
    ).toThrow(/must outlast/);
  });

  it('preserves an explicitly supplied id so a replayed write reproduces it', () => {
    const session = issue({ sessionId: '1b4e28ba-2fa1-4d1b-8f0e-4f2f5c1d9e33' });

    expect(session.id.value).toBe('1b4e28ba-2fa1-4d1b-8f0e-4f2f5c1d9e33');
  });

  it('mints a valid session id and family id', () => {
    const session = issue();

    expect(SessionId.isValid(session.id.value)).toBe(true);
    expect(SessionId.isValid(session.tokenFamilyId.value)).toBe(true);
  });
});

describe('Session.rotate', () => {
  it('consumes the presented token and issues its successor in the same family', () => {
    const session = issue();
    const presented = session.activeRefreshToken;

    const issued = session.rotate({
      presentedTokenId: presented?.id ?? '',
      next: { token: RefreshToken.mint() },
    });

    // The old token is spent, not deleted: its row is what makes a replay detectable later.
    const old = session.findRefreshToken(presented?.id ?? '');
    expect(old?.status).toBe(TokenStatus.RETIRED);
    expect(old?.retiredAt).toBeInstanceOf(Date);
    expect(old?.rotatedToTokenId).toBe(issued.id);
    expect(old?.isConsumed()).toBe(true);

    expect(issued.status).toBe(TokenStatus.ACTIVE);
    expect(issued.familyId).toBe(session.tokenFamilyId.value);
    expect(issued.jti).not.toBe(presented?.jti);
    expect(session.refreshTokens).toHaveLength(2);
  });

  it('leaves exactly one token usable, so a family cannot fork', () => {
    const session = issue();

    session.rotate({
      presentedTokenId: session.activeRefreshToken?.id ?? '',
      next: { token: RefreshToken.mint() },
    });

    expect(session.refreshTokens.filter((token) => token.status === TokenStatus.ACTIVE)).toHaveLength(1);
    expect(session.activeRefreshToken?.id).toBe(session.refreshTokens.at(-1)?.id);
  });

  it('emits session.refreshed naming both ends of the exchange', () => {
    const session = issue();
    const presentedId = session.activeRefreshToken?.id ?? '';
    session.clearDomainEvents();

    const issued = session.rotate({
      presentedTokenId: presentedId,
      next: { token: RefreshToken.mint() },
    });

    const [event] = session.domainEvents as SessionTokensRefreshed[];
    expect(event.eventType).toBe('session.refreshed');
    expect(event.payload.rotatedTokenId).toBe(presentedId);
    expect(event.payload.issuedTokenId).toBe(issued.id);
    expect(event.payload.tokenFamilyId).toBe(session.tokenFamilyId.value);
  });

  it('bumps the aggregate version in step with the event', () => {
    const session = issue();
    const before = session.version;
    session.clearDomainEvents();

    session.rotate({
      presentedTokenId: session.activeRefreshToken?.id ?? '',
      next: { token: RefreshToken.mint() },
    });

    // The outbox dedup key ends in this version, so a drift here would silently swallow or
    // duplicate events.
    expect(session.version).toBe(before + 1);
    expect(session.domainEvents[0]?.version).toBe(session.version);
  });

  it('does not extend the family beyond its original refresh deadline', () => {
    const session = issue();
    const deadline = session.refreshExpiresAt.getTime();

    const issued = session.rotate({
      presentedTokenId: session.activeRefreshToken?.id ?? '',
      next: { token: RefreshToken.mint() },
    });

    expect(issued.expiresAt.getTime()).toBe(deadline);
  });

  it('refuses to rotate a consumed token even when the caller asks nicely', () => {
    const session = issue();
    const presentedId = session.activeRefreshToken?.id ?? '';
    session.rotate({ presentedTokenId: presentedId, next: { token: RefreshToken.mint() } });

    // The handler routes a replay through family revocation; this is the belt to that
    // braces, so a caller that forgets still cannot re-open a spent token.
    expect(
      refusalOf(() =>
        session.rotate({ presentedTokenId: presentedId, next: { token: RefreshToken.mint() } }),
      ),
    ).toBe(SessionRefusal.REFRESH_TOKEN_REPLAYED);
  });

  it('refuses a token that belongs to another session', () => {
    const session = issue();
    const stranger = issue({ userId: OTHER_USER });
    const strangerTokenId = stranger.activeRefreshToken?.id ?? '';

    expect(
      refusalOf(() =>
        session.rotate({
          presentedTokenId: strangerTokenId,
          next: { token: RefreshToken.mint() },
        }),
      ),
    ).toBe(SessionRefusal.REFRESH_TOKEN_UNKNOWN);
  });
});

describe('Session rotation guards', () => {
  it('cannot rotate a revoked session', () => {
    const session = issue();
    const presentedId = session.activeRefreshToken?.id ?? '';
    session.revoke('user signed out');

    expect(
      refusalOf(() =>
        session.rotate({ presentedTokenId: presentedId, next: { token: RefreshToken.mint() } }),
      ),
    ).toBe(SessionRefusal.SESSION_NOT_ACTIVE);
  });

  it('cannot rotate an expired session', () => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const session = issue({ now: issuedAt });
    const presentedId = session.activeRefreshToken?.id ?? '';
    const anHourLater = new Date('2026-01-01T01:00:00.000Z');

    expect(
      refusalOf(() =>
        session.rotate({
          presentedTokenId: presentedId,
          next: { token: RefreshToken.mint() },
          now: anHourLater,
        }),
      ),
    ).toBe(SessionRefusal.SESSION_EXPIRED);
  });

  it('cannot rotate an expired refresh token, even while the session itself is alive', () => {
    // A session whose refresh window closed early — a shortened policy, a migrated row — is
    // still within its access-token lifetime, and must not mint a new refresh token.
    const now = new Date('2026-01-01T00:00:00.000Z');
    const session = Session.fromRow({
      id: '1b4e28ba-2fa1-4d1b-8f0e-4f2f5c1d9e33',
      user_id: USER,
      token_family_id: FAMILY,
      device_id: null,
      status: 'active',
      issued_at: now,
      expires_at: new Date('2026-01-02T00:00:00.000Z'),
      refresh_expires_at: new Date('2026-01-01T00:30:00.000Z'),
      revoked_at: null,
      revoke_reason: null,
      client_ip: null,
      user_agent: null,
      version: 4,
      created_at: now,
      updated_at: now,
      refresh_tokens: [
        {
          id: '5a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
          session_id: '1b4e28ba-2fa1-4d1b-8f0e-4f2f5c1d9e33',
          family_id: FAMILY,
          token_type: 'refresh',
          jti: '5a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
          token_digest: 'a'.repeat(64),
          status: 'active',
          issued_at: now,
          expires_at: new Date('2026-01-01T00:30:00.000Z'),
          rotated_to_token_id: null,
          retired_at: null,
          revoked_at: null,
          version: 1,
        },
      ],
    });

    expect(
      refusalOf(() =>
        session.rotate({
          presentedTokenId: '5a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
          next: { token: RefreshToken.mint() },
          now: new Date('2026-01-01T00:45:00.000Z'),
        }),
      ),
    ).toBe(SessionRefusal.REFRESH_TOKEN_EXPIRED);
  });
});

describe('Session.revoke', () => {
  it('withdraws the session and every token it ever issued', () => {
    const session = issue();
    session.rotate({
      presentedTokenId: session.activeRefreshToken?.id ?? '',
      next: { token: RefreshToken.mint() },
    });
    session.clearDomainEvents();

    const now = new Date('2026-01-01T12:00:00.000Z');
    session.revoke('user signed out', now);

    expect(session.status).toBe(SessionStatus.REVOKED);
    expect(session.revokeReason).toBe('user signed out');
    expect(session.revokedAt).toEqual(now);
    expect(session.refreshTokens.every((token) => token.status === TokenStatus.REVOKED)).toBe(true);

    const [event] = session.domainEvents as SessionRevoked[];
    expect(event.eventType).toBe('session.revoked');
    expect(event.payload).toMatchObject({ reason: 'user signed out', allSessions: false });
  });

  it('is idempotent — a queued sign-out retried must not publish twice', () => {
    const session = issue();
    session.revoke('first');
    session.clearDomainEvents();

    session.revoke('second');

    expect(session.domainEvents).toHaveLength(0);
    expect(session.revokeReason).toBe('first');
  });
});

describe('Session.expire', () => {
  it('retires a session whose lifetime has run out, without claiming it was revoked', () => {
    const session = issue({ now: new Date('2026-01-01T00:00:00.000Z') });
    session.clearDomainEvents();

    session.expire(new Date('2026-01-01T02:00:00.000Z'));

    expect(session.status).toBe(SessionStatus.EXPIRED);
    expect(session.revokeReason).toBe(EXPIRED_REVOKE_REASON);
    // `revoked_at` stays null: an expired session is not a security event, and an operator
    // filtering on revoked sessions should not see every logout from last month.
    expect(session.revokedAt).toBeNull();
    expect(session.refreshTokens.every((token) => token.status === TokenStatus.REVOKED)).toBe(true);

    const [event] = session.domainEvents as SessionRevoked[];
    expect(event.payload.reason).toBe(EXPIRED_REVOKE_REASON);
  });

  it('reports itself expired before anyone writes to the database', () => {
    const session = issue({ now: new Date('2026-01-01T00:00:00.000Z') });

    expect(session.isExpiredAt(new Date('2026-01-01T00:14:59.000Z'))).toBe(false);
    expect(session.isExpiredAt(new Date('2026-01-01T00:15:00.000Z'))).toBe(true);
    expect(session.status).toBe(SessionStatus.ACTIVE);
  });

  it('does not overwrite a revocation that already happened', () => {
    const session = issue();
    session.revoke('user signed out');

    session.expire();

    expect(session.status).toBe(SessionStatus.REVOKED);
    expect(session.revokeReason).toBe('user signed out');
  });
});

describe('Session.revokeFamilyOnReuse', () => {
  /**
   * Builds one family of two sessions plus a bystander in another family — the shape a
   * stolen token takes: one login's rotation chain, and one unrelated device.
   */
  const family = () => {
    // The `session.issued` events are cleared first: these assertions are about what the
    // revocation sweep emits, not about what issuing a session emitted.
    const owner = issue({ tokenFamilyId: FAMILY });
    const sibling = issue({ userId: OTHER_USER, tokenFamilyId: FAMILY });
    const bystander = issue({ tokenFamilyId: OTHER_FAMILY });
    owner.clearDomainEvents();
    sibling.clearDomainEvents();
    return { owner, sibling, bystander };
  };

  const replayOwnerToken = (owner: Session): string => {
    const presentedId = owner.activeRefreshToken?.id ?? '';
    owner.rotate({ presentedTokenId: presentedId, next: { token: RefreshToken.mint() } });
    owner.clearDomainEvents();
    return presentedId;
  };

  it('revokes every session sharing the family when a consumed token is replayed', () => {
    const { owner, sibling, bystander } = family();
    const presentedId = replayOwnerToken(owner);

    const revoked = Session.revokeFamilyOnReuse({
      sessions: [owner, sibling, bystander],
      tokenFamilyId: owner.tokenFamilyId,
      ownerSessionId: owner.id.value,
      presentedTokenId: presentedId,
    });

    expect(revoked).toHaveLength(2);
    expect(owner.isActive).toBe(false);
    expect(sibling.isActive).toBe(false);
    expect(sibling.revokeReason).toBe(REUSE_REVOKE_REASON);
    // A session from a different family belongs to a different login chain and must survive:
    // revoking it would sign a second device out for no reason.
    expect(bystander.isActive).toBe(true);
  });

  it('withdraws every token of every family member', () => {
    const { owner, sibling } = family();
    const presentedId = replayOwnerToken(owner);

    Session.revokeFamilyOnReuse({
      sessions: [owner, sibling],
      tokenFamilyId: owner.tokenFamilyId,
      ownerSessionId: owner.id.value,
      presentedTokenId: presentedId,
    });

    // The rotated-but-unused successor is revoked too: it is the token the legitimate client
    // is holding right now, and leaving it alive would let the theft continue.
    expect(owner.refreshTokens.every((token) => token.status === TokenStatus.REVOKED)).toBe(true);
    expect(sibling.refreshTokens.every((token) => token.status === TokenStatus.REVOKED)).toBe(true);
  });

  it('raises the reuse event once, from the session that owned the replayed token', () => {
    const { owner, sibling } = family();
    const presentedId = replayOwnerToken(owner);

    Session.revokeFamilyOnReuse({
      sessions: [owner, sibling],
      tokenFamilyId: owner.tokenFamilyId,
      ownerSessionId: owner.id.value,
      presentedTokenId: presentedId,
    });

    // One security event per replay: N sessions each announcing it would flood account
    // security with duplicate incidents.
    const ownerReuse = owner.domainEvents.filter(
      (event) => event.eventType === 'session.token_reuse_detected',
    );
    expect(ownerReuse).toHaveLength(1);
    expect(sibling.domainEvents.map((event) => event.eventType)).toEqual(['session.revoked']);

    const [event] = ownerReuse as SessionTokenReuseDetected[];
    expect(event.payload).toMatchObject({
      sessionId: owner.id.value,
      userId: USER,
      tokenFamilyId: FAMILY,
      presentedTokenId: presentedId,
      revokedCount: 2,
    });
  });

  it('refuses to report reuse for a token that is still active', () => {
    const { owner, sibling } = family();
    const activeId = owner.activeRefreshToken?.id ?? '';

    expect(
      refusalOf(() =>
        Session.revokeFamilyOnReuse({
          sessions: [owner, sibling],
          tokenFamilyId: owner.tokenFamilyId,
          ownerSessionId: owner.id.value,
          presentedTokenId: activeId,
        }),
      ),
    ).toBe(SessionRefusal.REFRESH_TOKEN_NOT_REPLAYED);
  });

  it('keeps announcing the reuse when the owning session was already revoked', () => {
    const { owner, sibling } = family();
    const presentedId = replayOwnerToken(owner);
    owner.revoke('signed out elsewhere');
    owner.clearDomainEvents();

    Session.revokeFamilyOnReuse({
      sessions: [owner, sibling],
      tokenFamilyId: owner.tokenFamilyId,
      ownerSessionId: owner.id.value,
      presentedTokenId: presentedId,
    });

    expect(owner.domainEvents.map((event) => event.eventType)).toEqual([
      'session.token_reuse_detected',
    ]);
  });
});

describe('Session.revokeAllExcept', () => {
  it('leaves the caller\'s own session signed in', () => {
    const phone = issue({ deviceId: 'phone' });
    const laptop = issue({ deviceId: 'laptop' });
    const tablet = issue({ deviceId: 'tablet' });

    const revoked = Session.revokeAllExcept(
      [phone, laptop, tablet],
      laptop.id.value,
      'signed out everywhere else',
    );

    expect(revoked).toHaveLength(2);
    expect(laptop.isActive).toBe(true);
    expect(phone.isActive).toBe(false);
    expect(tablet.isActive).toBe(false);
  });

  it('marks the bulk revocation so consumers can tell it from a single logout', () => {
    const phone = issue();
    const laptop = issue();
    phone.clearDomainEvents();

    Session.revokeAllExcept([phone, laptop], laptop.id.value, 'signed out everywhere else');

    const [event] = phone.domainEvents as SessionRevoked[];
    expect(event.payload.allSessions).toBe(true);
    expect(event.payload.reason).toBe('signed out everywhere else');
  });

  it('counts only what changed, so an already-revoked session is not re-reported', () => {
    const phone = issue();
    phone.revoke('earlier');
    const laptop = issue();

    const revoked = Session.revokeAllExcept([phone, laptop], null, 'signed out everywhere');

    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.id.equals(laptop.id)).toBe(true);
  });

  it('revokes everything when no exception is given', () => {
    const phone = issue();
    const laptop = issue();

    expect(Session.revokeAllExcept([phone, laptop], null, 'signed out')).toHaveLength(2);
  });
});

describe('Session.fromRow', () => {
  it('rehydrates without emitting events', () => {
    // Rehydration must not replay history: the write already happened and the events are
    // already in the outbox.
    const now = new Date('2026-01-01T00:00:00.000Z');
    const session = Session.fromRow({
      id: '1b4e28ba-2fa1-4d1b-8f0e-4f2f5c1d9e33',
      user_id: USER,
      token_family_id: FAMILY,
      device_id: 'laptop-1',
      status: 'revoked',
      issued_at: now,
      expires_at: new Date('2026-01-01T00:15:00.000Z'),
      refresh_expires_at: new Date('2026-01-31T00:00:00.000Z'),
      revoked_at: new Date('2026-01-01T00:05:00.000Z'),
      revoke_reason: REUSE_REVOKE_REASON,
      client_ip: null,
      user_agent: null,
      version: 7,
      created_at: now,
      updated_at: now,
      refresh_tokens: [],
    });

    expect(session.domainEvents).toHaveLength(0);
    expect(session.status).toBe(SessionStatus.REVOKED);
    expect(session.version).toBe(7);
    expect(session.id.value).toBe('1b4e28ba-2fa1-4d1b-8f0e-4f2f5c1d9e33');
    expect(session.tokenFamilyId.value).toBe(FAMILY);
    expect(session.deviceId).toBe('laptop-1');
  });
});