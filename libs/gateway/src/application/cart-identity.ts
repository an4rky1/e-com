import type { CartIdentityInput } from './ports/peer-clients.port';

export function cartIdentityFrom(
  identity: { readonly userId: string; readonly sessionId: string },
): CartIdentityInput {
  return { userId: identity.userId, sessionId: identity.sessionId };
}
