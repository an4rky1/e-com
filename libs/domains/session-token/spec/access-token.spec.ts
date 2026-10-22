import { createHmac } from 'node:crypto';
import {
  AccessTokenCodec,
  AccessTokenFailure,
} from '../src/domain/value-objects/access-token.vo';

const KEY = 'a-test-key-that-is-not-used-anywhere-else';
const OTHER_KEY = 'a-different-key-entirely-32-bytes-of-entropy';

/** The failure a verification produced, or `null` when it succeeded. */
const failureOf = (token: string, key = KEY): AccessTokenFailure | null => {
  const result = AccessTokenCodec.verify(token, key);
  return result.isFailure ? result.error : null;
};

const CLAIMS = {
  userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  sessionId: '1b4e28ba-2fa1-4d1b-8f0e-4f2f5c1d9e33',
  tokenFamilyId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  email: 'ada@example.com',
  roles: ['admin'],
  permissions: ['users:read'],
  issuedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-01T00:15:00.000Z'),
};

describe('AccessTokenCodec.sign', () => {
  it('produces a compact JWS with three segments', () => {
    const token = AccessTokenCodec.sign(CLAIMS, KEY);

    expect(token.split('.')).toHaveLength(3);
    // base64url only: a JWT travels in an Authorization header and a cookie.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('carries the claims the gateway needs and nothing else', () => {
    const verified = AccessTokenCodec.verify(AccessTokenCodec.sign(CLAIMS, KEY), KEY);

    expect(verified.unwrapOrThrow()).toEqual({
      sub: CLAIMS.userId,
      sid: CLAIMS.sessionId,
      email: CLAIMS.email,
      fam: CLAIMS.tokenFamilyId,
      roles: ['admin'],
      perms: ['users:read'],
      iat: Math.floor(CLAIMS.issuedAt.getTime() / 1_000),
      exp: Math.floor(CLAIMS.expiresAt.getTime() / 1_000),
    });
  });

  it('is deterministic, so a retried issue produces the same token', () => {
    // Determinism is a feature here: a request that timed out on the way back can be retried
    // without the client holding two different credentials for one session.
    expect(AccessTokenCodec.sign(CLAIMS, KEY)).toBe(AccessTokenCodec.sign(CLAIMS, KEY));
  });

  it('refuses to sign without a key', () => {
    // A blank key would produce a token whose signature anybody can recompute.
    expect(() => AccessTokenCodec.sign(CLAIMS, '')).toThrow(/signing key/);
  });
});

describe('AccessTokenCodec.verify', () => {
  it('rejects a token signed with a different key', () => {
    // Key rotation across replicas must not mint tokens that fail on another pod.
    const foreign = AccessTokenCodec.sign(CLAIMS, OTHER_KEY);

    expect(failureOf(foreign, KEY)).toBe(AccessTokenFailure.BAD_SIGNATURE);
  });

  it('rejects a tampered payload', () => {
    // The whole reason the token is signed: without this check, editing the payload would
    // authenticate as any user.
    const token = AccessTokenCodec.sign(CLAIMS, KEY);
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub: string;
    };
    claims.sub = '00000000-0000-4000-8000-000000000000';

    const forged = `${header}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;

    expect(failureOf(forged, KEY)).toBe(
      AccessTokenFailure.BAD_SIGNATURE,
    );
  });

  it('rejects an `alg: none` token', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'x' }), 'utf8').toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString(
      'base64url',
    );

    expect(failureOf(`${header}.${payload}.`, KEY)).toBe(
      AccessTokenFailure.MALFORMED,
    );
  });

  it('rejects anything that is not a compact JWS', () => {
    for (const token of ['', 'a.b', 'a.b.c.d', 'not-a-token']) {
      expect(failureOf(token, KEY)).toBe(
        AccessTokenFailure.MALFORMED,
      );
    }
  });

  it('rejects a well-signed token whose claims are the wrong shape', () => {
    // A signature over garbage is still garbage: the claim check has to fail closed.
    const payload = Buffer.from(JSON.stringify({ sub: 'x', roles: 'not-an-array' }), 'utf8')
      .toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', KEY)
      .update(`${header}.${payload}`, 'utf8')
      .digest('base64url');

    expect(failureOf(`${header}.${payload}.${signature}`, KEY)).toBe(
      AccessTokenFailure.MALFORMED,
    );
  });
});

describe('AccessTokenCodec expiry', () => {
  const claimsFor = (expiresAt: Date) =>
    AccessTokenCodec.verify(
      AccessTokenCodec.sign({ ...CLAIMS, expiresAt }, KEY),
      KEY,
    ).unwrapOrThrow();

  it('treats the expiry instant itself as expired', () => {
    // Off-by-one here would keep a token alive for one extra second past its `exp`.
    const claims = claimsFor(new Date('2026-01-01T00:15:00.000Z'));

    expect(AccessTokenCodec.isExpired(claims, new Date('2026-01-01T00:14:59.000Z'))).toBe(false);
    expect(AccessTokenCodec.isExpired(claims, new Date('2026-01-01T00:15:00.000Z'))).toBe(true);
  });

  it('reports the seconds a client can rely on, floored at zero', () => {
    const claims = claimsFor(new Date('2026-01-01T00:15:00.000Z'));

    expect(AccessTokenCodec.secondsUntilExpiry(claims, new Date('2026-01-01T00:00:00.000Z'))).toBe(900);
    expect(AccessTokenCodec.secondsUntilExpiry(claims, new Date('2026-01-01T01:00:00.000Z'))).toBe(0);
  });
});