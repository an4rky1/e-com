/**
 * @fileoverview Which key a cart lives under, and what else has to be touched with it.
 *
 * @remarks The rule this file pins is one line and everything else in the service derives
 * from it: a signed-in shopper's cart belongs to the *user*, a guest's belongs to the
 * *session*. Get that wrong and a shopper's basket follows the wrong device, or two
 * shoppers share one cart — failures that look like data loss and are not repairable by
 * the caller.
 *
 * @remarks The lock names are asserted here too, even though ordering is the lock's job:
 * which keys a request *may* hold is this module's answer, and a merge that forgot the
 * guest key would merge nothing at all.
 */
import { ValidationException } from '@auth/platform/error-handling';
import { lockNamesFor, resolveCartOwner } from '../src/domain/cart-owner';
import { SESSION_ID, USER_ID } from './support/fakes';

describe('resolveCartOwner', () => {
  it('gives a signed-in shopper the user key, so the basket follows them', () => {
    expect(resolveCartOwner({ sessionId: SESSION_ID, userId: USER_ID })).toEqual({
      key: `user:${USER_ID}`,
      guestKey: `session:${SESSION_ID}`,
    });
  });

  it('gives a guest the session key, so the basket dies with the session', () => {
    expect(resolveCartOwner({ sessionId: SESSION_ID, userId: '' })).toEqual({
      key: `session:${SESSION_ID}`,
      guestKey: null,
    });
  });

  it('has no guest key for a signed-in request that arrived without a session', () => {
    // There is nothing to fold in, and naming a key derived from `''` would make the
    // merge read — and then discard — somebody else's guest cart.
    expect(resolveCartOwner({ sessionId: '', userId: USER_ID })).toEqual({
      key: `user:${USER_ID}`,
      guestKey: null,
    });
  });

  it('refuses a request with neither identifier rather than sharing one anonymous cart', () => {
    // There is no "the cart" without one of them, and inventing an anonymous key would
    // hand every unidentified caller the same basket.
    expect(() => resolveCartOwner({ sessionId: '', userId: '' })).toThrow(ValidationException);
    expect(() => resolveCartOwner({ sessionId: '   ', userId: '' })).toThrow(
      /needs a sessionId or a userId/,
    );
  });

  it('trims both identifiers before keying on them', () => {
    expect(resolveCartOwner({ sessionId: `  ${SESSION_ID}  `, userId: ` ${USER_ID} ` })).toEqual({
      key: `user:${USER_ID}`,
      guestKey: `session:${SESSION_ID}`,
    });
  });

  it('prefers the user key when both identifiers are present, whatever their order', () => {
    // A shopper who signs in on a session that already had a basket must land on the user
    // cart — otherwise the merge would fold the user's cart into the session's.
    expect(resolveCartOwner({ sessionId: SESSION_ID, userId: USER_ID }).key).toBe(
      `user:${USER_ID}`,
    );
  });
});

describe('lockNamesFor', () => {
  it('names the shopper cart and the guest cart when there is a merge to do', () => {
    expect(lockNamesFor(resolveCartOwner({ sessionId: SESSION_ID, userId: USER_ID }))).toEqual([
      `user:${USER_ID}`,
      `session:${SESSION_ID}`,
    ]);
  });

  it('names only the one key when there is nothing to merge', () => {
    expect(lockNamesFor(resolveCartOwner({ sessionId: SESSION_ID, userId: '' }))).toEqual([
      `session:${SESSION_ID}`,
    ]);
  });

  it('never names a guest key for a request that has no session', () => {
    const names = lockNamesFor(resolveCartOwner({ sessionId: '', userId: USER_ID }));

    expect(names).toEqual([`user:${USER_ID}`]);
    expect(names).not.toContain('session:');
  });
});
