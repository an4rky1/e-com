/**
 * @fileoverview Which key a cart lives under, and what else has to be touched with it.
 *
 * @remarks `cart.proto` addresses every call with a `session_id` and a `user_id`, but a
 * cart has exactly one home. The rule is deliberately one line: a signed-in shopper's cart
 * belongs to the *user* (so it follows them across devices), a guest's belongs to the
 * *session* (so it dies with the session's TTL). Everything else in this service — the
 * lock, the merge, the key written to Redis — is derived from that one decision.
 *
 * @remarks The guest key is carried alongside rather than recomputed at each call site
 * because it is the whole point of the merge: the same session that was shopping as a
 * guest is now authenticated, and its cart is one key away from the one being read.
 */
import { ValidationException } from '@auth/platform/error-handling';

/** The two identifiers every `cart.v1` request carries. */
export interface CartIdentity {
  readonly sessionId: string;
  readonly userId: string;
}

export interface CartOwner {
  /** The key the cart is stored under. */
  readonly key: string;
  /**
   * The guest cart to fold in, when there is one.
   *
   * @remarks `null` for a guest request (their cart *is* the guest key) and for an
   * authenticated request that arrived without a session.
   */
  readonly guestKey: string | null;
}

/**
 * The key prefix that separates "this person" from "this browser".
 *
 * @remarks A raw `user:{id}` / `session:{id}` pair, not a hash: the keys are read by
 * operators during an incident, and `GET cart:data:user:42` answers a question that
 * `GET cart:data:9f2c…` does not.
 */
const sessionKey = (sessionId: string): string => `session:${sessionId}`;
const userKey = (userId: string): string => `user:${userId}`;

/**
 * Resolves the cart a request addresses.
 *
 * @remarks Refuses a request with neither identifier. There is no "the cart" without one
 * of them, and inventing an anonymous key would hand every unidentified caller the same
 * shared cart.
 */
export function resolveCartOwner(identity: CartIdentity): CartOwner {
  const sessionId = identity.sessionId?.trim() ?? '';
  const userId = identity.userId?.trim() ?? '';

  if (sessionId.length === 0 && userId.length === 0) {
    throw new ValidationException(
      'a cart request needs a sessionId or a userId',
      { sessionId: identity.sessionId, userId: identity.userId },
    );
  }

  if (userId.length > 0) {
    return {
      key: userKey(userId),
      guestKey: sessionId.length > 0 ? sessionKey(sessionId) : null,
    };
  }

  return { key: sessionKey(sessionId), guestKey: null };
}

/**
 * Every key a request may have to hold, so the lock can take them as one set.
 *
 * @remarks The order is not decided here. {@link CartOwner}'s two keys are held by two
 * requests at once only during a merge, and the fixed acquisition order belongs with the
 * code that actually takes the locks — a rule stated at the call site is a rule the next
 * call site forgets.
 */
export function lockNamesFor(owner: CartOwner): string[] {
  return owner.guestKey ? [owner.key, owner.guestKey] : [owner.key];
}
