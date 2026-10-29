/**
 * @fileoverview The guard auth-flow reuses.
 *
 * @remarks The guard's whole contract is "a route either opts out, or the request carries a
 * proven second factor". Every branch below exists because a mistake in one of them is a
 * security failure rather than a bad response: failing open lets an unverified caller through,
 * and failing closed locks every legitimate user out of sign-in.
 *
 * @remarks The challenge port is a stub, and legitimately so — the guard never learns *how*
 * a code is checked, which is the property being tested. The checking itself is covered in
 * `mfa.handlers.spec.ts`.
 */

import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MfaRequiredException } from '@auth/platform/error-handling';
import { MfaGuard } from '../src/presentation/guards/mfa.guard';
import { SKIP_MFA, SkipMfa } from '../src/presentation/decorators/skip-mfa.decorator';
import type { MfaChallengePort } from '../src/domain/ports/mfa-challenge.port';

// ---- guard ---------------------------------------------------------------------

class RecordingChallenge implements MfaChallengePort {
  readonly asked: { userId: string; code: string }[] = [];
  constructor(private readonly answer: boolean) {}

  async verifyOwnership(input: { userId: string; code: string }): Promise<boolean> {
    this.asked.push(input);
    return this.answer;
  }
}

/** The minimal `ExecutionContext` shape the guard reads. */
const contextFor = (
  request: Record<string, unknown>,
  skipMetadata: { skip?: boolean } = {},
): ExecutionContext => {
  const handler = (): void => undefined;
  if (skipMetadata.skip === true) Reflect.defineMetadata(SKIP_MFA, true, handler);

  return {
    getHandler: () => handler,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

const reflectorFor = (): Reflector => new Reflector();

describe('SkipMfa', () => {
  it('sets metadata a reflector can read back', () => {
    class Target {
      @SkipMfa()
      handler(): void {
        /* noop */
      }
    }

    expect(new Reflector().get<boolean>(SKIP_MFA, Target.prototype.handler)).toBe(true);
  });
});

describe('MfaGuard', () => {
  it('lets an opted-out route through without asking anything', async () => {
    const challenge = new RecordingChallenge(false);
    const guard = new MfaGuard(reflectorFor(), challenge);

    await expect(guard.canActivate(contextFor({ user: {} }, { skip: true }))).resolves.toBe(true);
    expect(challenge.asked).toHaveLength(0);
  });

  it('accepts a principal that already proved a second factor', async () => {
    const challenge = new RecordingChallenge(false);
    const guard = new MfaGuard(reflectorFor(), challenge);

    await expect(
      guard.canActivate(contextFor({ user: { userId: 'u1', mfaVerified: true } })),
    ).resolves.toBe(true);
    expect(challenge.asked).toHaveLength(0);
  });

  it('accepts the OIDC `amr` spelling too', async () => {
    const guard = new MfaGuard(reflectorFor(), new RecordingChallenge(false));

    await expect(
      guard.canActivate(contextFor({ user: { sub: 'u1', amr: ['pwd', 'otp'] } })),
    ).resolves.toBe(true);
  });

  it('checks an inline code when the principal has not proven one', async () => {
    const challenge = new RecordingChallenge(true);
    const guard = new MfaGuard(reflectorFor(), challenge);

    await expect(
      guard.canActivate(contextFor({ user: { userId: 'u1' }, body: { mfaCode: '123456' } })),
    ).resolves.toBe(true);
    expect(challenge.asked).toEqual([{ userId: 'u1', code: '123456' }]);
  });

  it('prefers the header, so a code never has to live in a URL', async () => {
    const challenge = new RecordingChallenge(true);
    const guard = new MfaGuard(reflectorFor(), challenge);

    await expect(
      guard.canActivate(
        contextFor({
          user: { userId: 'u1' },
          headers: { 'x-mfa-code': '654321' },
          body: { mfaCode: '111111' },
        }),
      ),
    ).resolves.toBe(true);
    expect(challenge.asked[0]?.code).toBe('654321');
  });

  it('refuses a wrong code', async () => {
    const guard = new MfaGuard(reflectorFor(), new RecordingChallenge(false));

    await expect(
      guard.canActivate(contextFor({ user: { userId: 'u1' }, body: { code: '000000' } })),
    ).rejects.toBeInstanceOf(MfaRequiredException);
  });

  it('refuses a request with no principal', async () => {
    const challenge = new RecordingChallenge(true);
    const guard = new MfaGuard(reflectorFor(), challenge);

    await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
      MfaRequiredException,
    );
    expect(challenge.asked).toHaveLength(0);
  });

  it('refuses when no code was presented at all', async () => {
    const guard = new MfaGuard(reflectorFor(), new RecordingChallenge(true));

    await expect(guard.canActivate(contextFor({ user: { userId: 'u1' } }))).rejects.toBeInstanceOf(
      MfaRequiredException,
    );
  });

  it('answers the same exception for a wrong code and for no code', async () => {
    // The two must be indistinguishable, or the endpoint tells an attacker which of the two
    // is worth trying again.
    const guard = new MfaGuard(reflectorFor(), new RecordingChallenge(false));

    const wrong = await guard
      .canActivate(contextFor({ user: { userId: 'u1' }, body: { code: '000000' } }))
      .catch((error: unknown) => error);
    const none = await guard
      .canActivate(contextFor({ user: { userId: 'u1' } }))
      .catch((error: unknown) => error);

    expect(wrong).toBeInstanceOf(MfaRequiredException);
    expect(none).toBeInstanceOf(MfaRequiredException);
  });
});

