/**
 * @fileoverview Google's half of the redirect walk — its rooms and its profile claims.
 *
 * @remarks Google is the reference walk: every quirk here is *Google's own* — the endpoint
 * that wants `response_type` and `grant_type` spelled out, OpenID's `email_verified` claim
 * arriving as a boolean or as the string `"true"` depending on which endpoint answered.
 * Keeping them next to each other in one file is what stops them from being re-derived at
 * the call site of a fourth provider.
 *
 * @remarks The verification requirement lives in {@link googleProfileOf}: a Google address
 * is accepted only when the provider vouched for it. `email_verified: false` is not a
 * slower true — it is the difference between "this inbox belongs to this account" and
 * "somebody typed this inbox into a form", and only the first links an account.
 */
import { ValidationException } from '@auth/platform/error-handling';
import { redirectProvider, type ProviderEndpoints } from './redirect';
import type { OAuthProfile } from './types';

const GOOGLE_ENDPOINTS: ProviderEndpoints = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  scope: 'openid email profile',
};

export const googleProvider = redirectProvider({
  name: 'google',
  endpoints: GOOGLE_ENDPOINTS,
  authorizeQuery: { response_type: 'code' },
  tokenForm: { grant_type: 'authorization_code' },
  profileOf: (_ctx, _endpoints, _accessToken, body) => googleProfileOf(body),
});

/** OpenID's claim is a boolean, and a provider that stringifies it is still telling the truth. */
function googleProfileOf(body: Record<string, unknown>): OAuthProfile {
  if (typeof body.sub !== 'string' || body.sub.length === 0) {
    throw new ValidationException('the provider did not identify the account', { provider: 'google' });
  }
  const verified = body.email_verified === true || body.email_verified === 'true';
  if (typeof body.email !== 'string' || body.email.length === 0 || !verified) {
    throw new ValidationException('the provider did not return a verified email address', {
      provider: 'google',
    });
  }
  return {
    subject: body.sub,
    email: body.email,
    emailVerified: true,
    displayName: typeof body.name === 'string' ? body.name : undefined,
  };
}
