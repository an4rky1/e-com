import { RefreshToken } from '../src/domain/value-objects/refresh-token.vo';
import { TokenDigester } from '../src/domain/value-objects/token-digester.vo';

describe('TokenDigester.digest', () => {
  it('is deterministic — the same token always yields the same stored value', () => {
    // Determinism is the whole contract: lookup digests a presented token and compares it
    // with what was written at issue time.
    const token = RefreshToken.mint();

    expect(TokenDigester.digest(token)).toBe(TokenDigester.digest(token));
  });

  it('accepts the plaintext or the value object and agrees on both', () => {
    // Two entry points exist so a caller never has to unwrap the token by hand, and a
    // mismatch between them would silently lock every user out.
    const token = RefreshToken.mint();

    expect(TokenDigester.digest(token.value)).toBe(TokenDigester.digest(token));
  });

  it('produces nothing from which the token can be read back', () => {
    const token = RefreshToken.mint();
    const digest = TokenDigester.digest(token);

    expect(digest).not.toContain(token.value);
    expect(digest).toHaveLength(TokenDigester.DIGEST_LENGTH);
    // Base64 and hex alphabets both appear in a token; the digest is hex only.
    expect(digest).toMatch(/^[0-9a-f]+$/);
  });

  it('gives different digests to different tokens', () => {
    // Two sessions must never collide, or one user's refresh token would unlock another's.
    expect(TokenDigester.digest(RefreshToken.mint())).not.toBe(
      TokenDigester.digest(RefreshToken.mint()),
    );
  });

  it('is insensitive to nothing at all — one changed byte changes the digest', () => {
    const token = RefreshToken.mint();

    expect(TokenDigester.digest(token.value)).not.toBe(
      TokenDigester.digest(`${token.value.slice(0, -1)}x`),
    );
  });
});

describe('TokenDigester.matches', () => {
  it('confirms a token against its own digest', () => {
    const token = RefreshToken.mint();

    expect(TokenDigester.matches(token, TokenDigester.digest(token))).toBe(true);
  });

  it('rejects a token that was never issued', () => {
    expect(TokenDigester.matches(RefreshToken.mint(), TokenDigester.digest(RefreshToken.mint())))
      .toBe(false);
  });

  it('rejects a digest of a different length without throwing', () => {
    // A truncated or empty column must fail closed, not blow up on a buffer comparison.
    expect(TokenDigester.matches(RefreshToken.mint(), '')).toBe(false);
    expect(TokenDigester.matches(RefreshToken.mint(), 'abc')).toBe(false);
  });
});

describe('TokenDigester.mintJti', () => {
  it('mints a distinct, opaque id every time', () => {
    // The jti is the token's public identity in the table; it must not be derived from the
    // secret, or it would leak the same information the digest hides.
    const first = TokenDigester.mintJti();
    const second = TokenDigester.mintJti();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('RefreshToken', () => {
  it('mints 256 bits of entropy, url-safe', () => {
    const token = RefreshToken.mint();

    expect(Buffer.from(token.value, 'base64url')).toHaveLength(32);
    expect(token.value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a value too short to have been issued by this service', () => {
    const result = RefreshToken.tryCreate('short');

    expect(result.isFailure).toBe(true);
    expect(result.getErrorOr('')).toMatch(/too short/);
  });

  it('refuses a non-string without throwing', () => {
    // The value arrives from a gRPC or JSON boundary, so it can be anything at all.
    expect(RefreshToken.tryCreate(undefined).isFailure).toBe(true);
    expect(RefreshToken.tryCreate(42).isFailure).toBe(true);
  });

  it('has no printable form of itself', () => {
    // Anything that stringifies a token — a logger, an exception context, a template — must
    // produce the redaction marker rather than a usable credential.
    const token = RefreshToken.mint();

    expect(`${token}`).toBe('[REDACTED]');
    expect(JSON.stringify({ token })).not.toContain(token.value);
  });
});