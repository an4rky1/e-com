/**
 * @fileoverview GitHub's half of the redirect walk — two rooms instead of one.
 *
 * @remarks GitHub's `/user` carries a public `email` field that is optional and never
 * vouched for, so this walk does not read it. The address comes from `/user/emails`, where
 * every row carries its own `verified` flag and `primary` names the one the person chose.
 * The preference order — primary-and-verified, then any verified — means a person with
 * several addresses signs the walk with the one they actually use, and a person with none
 * is refused rather than linked on somebody else's word.
 *
 * @remarks A missing `emailsUrl` in the table below is a build mistake, not a runtime
 * condition: quietly proceeding without the verified list would drop the very check that
 * makes link-by-address safe, so it is reported as the platform's 500 rather than assumed.
 */
import { InternalErrorException, ValidationException } from '@auth/platform/error-handling';
import {
  asRecord,
  type OAuthProfile,
  type ProviderContext,
} from './types';
import { redirectProvider, type ProviderEndpoints } from './redirect';

const GITHUB_ENDPOINTS: ProviderEndpoints = {
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  profileUrl: 'https://api.github.com/user',
  emailsUrl: 'https://api.github.com/user/emails',
  scope: 'read:user user:email',
};

export const githubProvider = redirectProvider({
  name: 'github',
  endpoints: GITHUB_ENDPOINTS,
  profileOf: (ctx, endpoints, accessToken, body) =>
    githubProfileOf(ctx, endpoints, accessToken, body),
});

/**
 * GitHub: the address comes from the verified list, never from the summary field.
 *
 * @remarks The subject is GitHub's numeric account id — stable for life, unlike a login
 * the person can rename — so the account links on the id and the address is only ever the
 * *contact* the provider vouches for.
 */
async function githubProfileOf(
  ctx: ProviderContext,
  endpoints: ProviderEndpoints,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<OAuthProfile> {
  if (typeof body.id !== 'number' && typeof body.id !== 'string') {
    throw new ValidationException('the provider did not identify the account', { provider: 'github' });
  }
  const subject = String(body.id);
  if (subject.length === 0) {
    throw new ValidationException('the provider did not identify the account', { provider: 'github' });
  }
  if (typeof endpoints.emailsUrl !== 'string') {
    throw new InternalErrorException(undefined, {
      provider: 'github',
      reason: 'the verified-email endpoint is missing from the provider table',
    });
  }

  const listed = await ctx.http.getJson(endpoints.emailsUrl, accessToken);
  const emails = Array.isArray(listed)
    ? listed.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const chosen =
    emails.find((entry) => entry.primary === true && entry.verified === true) ??
    emails.find((entry) => entry.verified === true);
  const email = chosen?.email;
  if (typeof email !== 'string' || email.length === 0) {
    throw new ValidationException('the provider did not return a verified email address', {
      provider: 'github',
    });
  }

  const name =
    typeof body.name === 'string' && body.name.length > 0
      ? body.name
      : typeof body.login === 'string' && body.login.length > 0
        ? body.login
        : undefined;

  return { subject, email, emailVerified: true, displayName: name };
}
