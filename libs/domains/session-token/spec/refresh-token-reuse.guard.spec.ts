import {
  TokenReuseDetectedException,
} from '@auth/platform/error-handling';
import { RefreshTokenReuseGuard } from '../src/application/commands/refresh-token-reuse.guard';
import {
  SessionSpecification,
  type RefreshTokenMatch,
  type SessionRepositoryPort,
} from '../src/domain/ports/session-repository.port';
import { Session } from '../src/domain/session.aggregate';
import { RefreshToken } from '../src/domain/value-objects/refresh-token.vo';
import { TokenStatus } from '../src/domain/value-objects/token-status.vo';
import type { SessionTokenConfig } from '../src/session-token.config';

const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FAMILY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_FAMILY = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

const CONFIG: SessionTokenConfig = {
  accessTokenTtlSec: 900,
  refreshTokenTtlSec: 2_592_000,
  clockSkewSec: 30,
  reuseRevokesFamily: true,
  accessTokenSigningKey: 'a-test-key-that-is-not-used-anywhere-else',
};

interface SavedWrite {
  readonly session: Session;
  readonly events: string[];
}

/**
 * Stands in for the Prisma adapter.
 *
 * @remarks The property under test — that a family is revoked *before* the caller is told —
 * lives in the orchestration, so the test drives the real guard against a plain object instead
 * of a database. The `saved` log stands in for the commit: an event that never reached it did
 * not happen.
 */
class InMemorySessionRepository implements SessionRepositoryPort {
  readonly sessions: Session[] = [];
  readonly saved: SavedWrite[] = [];

  async save(session: Session): Promise<void> {
    this.persist([session]);
  }

  async saveMany(sessions: readonly Session[]): Promise<void> {
    this.persist(sessions);
  }

  private persist(sessions: readonly Session[]): void {
    for (const session of sessions) {
      this.saved.push({
        session,
        events: session.clearDomainEvents().map((event) => event.eventType),
      });

      const existing = this.sessions.findIndex((candidate) =>
        candidate.id.equals(session.id),
      );
      if (existing === -1) this.sessions.push(session);
      else this.sessions[existing] = session;
    }
  }

  async findById(id: string): Promise<Session | null> {
    return this.sessions.find((session) => session.id.value === id) ?? null;
  }

  async find(spec: SessionSpecification): Promise<Session[]> {
    return this.sessions.filter((session) => spec.isSatisfiedBy(session));
  }

  async count(spec: SessionSpecification): Promise<number> {
    return (await this.find(spec)).length;
  }

  async findActiveByUser(userId: string, exceptSessionId?: string): Promise<Session[]> {
    return this.sessions.filter(
      (session) =>
        session.userId === userId &&
        session.isActive &&
        session.id.value !== exceptSessionId,
    );
  }

  async findByFamilyId(tokenFamilyId: string): Promise<Session[]> {
    return this.sessions.filter((session) => session.tokenFamilyId.value === tokenFamilyId);
  }

  async findRefreshTokenByDigest(digest: string): Promise<RefreshTokenMatch | null> {
    for (const session of this.sessions) {
      const token = session.findRefreshTokenByDigest(digest);
      if (token) return { session, token };
    }
    return null;
  }
}

/**
 * Issues a session and returns the plaintext the caller would have been handed.
 *
 * @remarks The aggregate keeps no copy of the secret — only its digest — so a test that wants
 * to present it again has to hold on to it the way a real client does.
 */
async function issued(
  repository: InMemorySessionRepository,
  overrides: Partial<Parameters<typeof Session.issue>[0]> = {},
): Promise<{ session: Session; plaintext: string }> {
  const token = RefreshToken.mint();
  const session = Session.issue({
    userId: USER,
    accessTokenTtlSec: CONFIG.accessTokenTtlSec,
    refreshTokenTtlSec: CONFIG.refreshTokenTtlSec,
    refreshToken: { token },
    ...overrides,
  });
  await repository.save(session);
  return { session, plaintext: token.value };
}

const setup = (config: SessionTokenConfig = CONFIG) => {
  const repository = new InMemorySessionRepository();
  return { repository, guard: new RefreshTokenReuseGuard(repository, config) };
};

/**
 * The attack: a thief obtains a refresh token and races the legitimate client. The winner
 * rotates first; the loser then presents a token that has already been consumed — which is
 * what the guard is handed.
 */
const stageReuse = async (config: SessionTokenConfig = CONFIG) => {
  const { repository, guard } = setup(config);
  const owner = await issued(repository, { tokenFamilyId: FAMILY, deviceId: 'laptop' });
  const sibling = await issued(repository, { tokenFamilyId: FAMILY, deviceId: 'phone' });
  const bystander = await issued(repository, {
    tokenFamilyId: OTHER_FAMILY,
    deviceId: 'tablet',
  });

  // The thief gets there first, so the token the victim now holds is already spent.
  const consumedId = owner.session.activeRefreshToken?.id ?? '';
  owner.session.rotate({
    presentedTokenId: consumedId,
    next: { token: RefreshToken.mint() },
  });
  await repository.save(owner.session);

  return { repository, guard, owner, sibling, bystander, consumedId };
};

describe('RefreshTokenReuseGuard', () => {
  it('rejects the replay instead of returning a new token', async () => {
    const { guard, owner, consumedId } = await stageReuse();

    await expect(
      guard.revokeFamilyAndReport({
        session: owner.session,
        presentedTokenId: consumedId,
      }),
    ).rejects.toBeInstanceOf(TokenReuseDetectedException);
  });

  it('revokes the whole family before the exception leaves the guard', async () => {
    const { guard, owner, sibling, consumedId } = await stageReuse();

    try {
      await guard.revokeFamilyAndReport({
        session: owner.session,
        presentedTokenId: consumedId,
      });
      throw new Error('expected the replay to be rejected');
    } catch {
      // Asserted from the aggregate, not from the caught error: the point is that the
      // revocations are already durable by the time the caller learns of the theft. Throwing
      // from inside the transaction would have rolled them back.
      expect(owner.session.isActive).toBe(false);
      expect(sibling.session.isActive).toBe(false);
      expect(owner.session.revokeReason).toBe('refresh_token_reuse');
      expect(
        owner.session.refreshTokens.every((token) => token.status === TokenStatus.REVOKED),
      ).toBe(true);
      expect(
        sibling.session.refreshTokens.every((token) => token.status === TokenStatus.REVOKED),
      ).toBe(true);
    }
  });

  it('commits every revocation to storage, not just to the in-memory aggregate', async () => {
    const { repository, guard, owner, sibling, consumedId } = await stageReuse();

    await expect(
      guard.revokeFamilyAndReport({ session: owner.session, presentedTokenId: consumedId }),
    ).rejects.toBeInstanceOf(TokenReuseDetectedException);

    const persisted = repository.sessions.map((session) => session.status);
    expect(persisted).toHaveLength(3);
    expect(persisted.filter((status) => status === 'revoked')).toHaveLength(2);
    expect(await repository.count(new ActiveSessionsSpec())).toBe(1);
    expect(sibling.session.id.value).toBeTruthy();
  });

  it('leaves a session from another family signed in', async () => {
    const { guard, owner, bystander, consumedId } = await stageReuse();

    await expect(
      guard.revokeFamilyAndReport({ session: owner.session, presentedTokenId: consumedId }),
    ).rejects.toBeInstanceOf(TokenReuseDetectedException);

    expect(bystander.session.isActive).toBe(true);
  });

  it('publishes one reuse event and one revocation per family member', async () => {
    const { repository, guard, owner, consumedId } = await stageReuse();
    const before = repository.saved.length;

    await expect(
      guard.revokeFamilyAndReport({ session: owner.session, presentedTokenId: consumedId }),
    ).rejects.toBeInstanceOf(TokenReuseDetectedException);

    const events = repository.saved.slice(before).flatMap((write) => write.events);
    // One security event per replay: N sessions each announcing it would flood account
    // security with duplicate incidents. Both sessions still announce the revocation, because
    // a consumer that caches sessions learns about it from the revocation topic.
    expect(events.filter((type) => type === 'session.token_reuse_detected')).toHaveLength(1);
    expect(events.filter((type) => type === 'session.revoked')).toHaveLength(2);
  });

  it('records which token was replayed, so the incident can be traced', async () => {
    const { guard, owner, consumedId } = await stageReuse();

    await expect(
      guard.revokeFamilyAndReport({ session: owner.session, presentedTokenId: consumedId }),
    ).rejects.toMatchObject({
      code: 'TOKEN_REUSE_DETECTED',
      context: expect.objectContaining({
        // `session_id` is on the platform's redaction list, so it reaches the log as
        // `[REDACTED]` — the family and the token id are what make the incident traceable.
        sessionId: '[REDACTED]',
        tokenFamilyId: FAMILY,
        presentedTokenId: consumedId,
        revokedSessions: 2,
      }) as unknown,
    });
  });

  it('still refuses the replay when the family sweep is disabled, but keeps it signed in', async () => {
    const { guard, owner, sibling, consumedId } = await stageReuse({
      ...CONFIG,
      reuseRevokesFamily: false,
    });

    await expect(
      guard.revokeFamilyAndReport({ session: owner.session, presentedTokenId: consumedId }),
    ).rejects.toBeInstanceOf(TokenReuseDetectedException);

    // The escape hatch only changes the blast radius; the replay itself is still refused.
    expect(owner.session.isActive).toBe(true);
    expect(sibling.session.isActive).toBe(true);
  });
});

/** Local copy so the assertion reads in the domain's vocabulary. */
class ActiveSessionsSpec extends SessionSpecification {
  isSatisfiedBy(session: Session): boolean {
    return session.isActive;
  }
}