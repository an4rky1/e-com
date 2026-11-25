/**
 * @fileoverview The bodies that cross the edge: what a caller may send, what the gateway
 * answers, and the limits both sides check against.
 *
 * @remarks The gateway enforces every field and every number here with class-validator on
 * its DTO classes — that validation is the boundary. The front checks the same constants
 * before it spends a request, so a too-long email is refused by the form's own endpoint
 * instead of making a round trip. Constants live here precisely so the two checks cannot
 * drift apart: the browser's gate and the server's gate read the same numbers.
 */
import type { RoleKey } from '../access';
import type { TokenPair } from '../auth.types';

export type { TokenPair };
export { TOKEN_TYPE_BEARER } from '../auth.types';

// ---- field limits, shared by both gates -------------------------------------------

export const EMAIL_MAX_LENGTH = 254;
/**
 * Password length bounds both gates check.
 *
 * @remarks One number, two readers: the edge's DTOs validate against these, and the vault's
 * policy imports them as its floor and ceiling ({@link PASSWORD_MIN_LENGTH} is the vault's
 * `PASSWORD_MIN_LENGTH_FLOOR`). A composition rule (uppercase, digit, symbol) still belongs
 * to the vault alone — the edge refuses only what it can judge by length, so a password the
 * vault's stricter policy rejects still reaches the vault and is refused there, before any
 * account exists.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
/**
 * Refresh-token length bounds.
 *
 * @remarks The session service mints 32 random bytes as base64url (43 characters); the floor
 * rejects malformed input before a digest lookup, and the ceiling keeps a garbage string from
 * travelling further than the first validator. Both the edge's DTO and the session service's
 * own transport DTO read these constants, so a token the edge forwards is a token session
 * accepts.
 */
export const REFRESH_TOKEN_MIN_LENGTH = 20;
export const REFRESH_TOKEN_MAX_LENGTH = 512;
export const DISPLAY_NAME_MAX_LENGTH = 200;
export const LOCALE_MIN_LENGTH = 2;
export const LOCALE_MAX_LENGTH = 10;
/** A short operator- or user-supplied reason (logout, cancellation, revocation). */
export const REASON_MAX_LENGTH = 200;
/** A longer free-text description (role, policy). Distinct from {@link REASON_MAX_LENGTH}. */
export const DESCRIPTION_MAX_LENGTH = 500;
/** The device a session was issued on, as the client reports it. */
export const DEVICE_ID_MAX_LENGTH = 200;
/** Slack over an IPv4/IPv6 literal so a malformed value fails on length before parsing. */
export const IP_ADDRESS_MAX_LENGTH = 64;
/** A user id at its slack: a uuid is 36 characters, same rationale as {@link GUEST_ID_MAX_LENGTH}. */
export const USER_ID_MAX_LENGTH = 64;
/** A serialised access token (JWT) at its practical ceiling. */
export const ACCESS_TOKEN_MAX_LENGTH = 8_192;
/** How many roles a token payload may carry. */
export const ROLES_MAX_COUNT = 50;
/** How many permissions a token payload may carry. */
export const PERMISSIONS_MAX_COUNT = 200;

// ---- pagination, shared by every paged endpoint ------------------------------------

/** Page size a caller gets when they ask for none. */
export const DEFAULT_PAGE_SIZE = 20;
/** Ceiling on a requested page size; larger asks are clamped, not refused. */
export const MAX_PAGE_SIZE = 100;

// ---- mfa ----------------------------------------------------------------------------

/** What an authenticator app may call a factor (`totp` today; room for more). */
export const MFA_METHOD_MAX_LENGTH = 32;
/** The label a user gives a factor, e.g. `Pixel 8`. */
export const MFA_ACCOUNT_LABEL_MAX_LENGTH = 120;
/** A factor id at its slack: a uuid is 36 characters. */
export const FACTOR_ID_MAX_LENGTH = 64;
/** How many recovery codes a caller may ask to regenerate at once. */
export const RECOVERY_CODE_COUNT_MAX = 20;
/**
 * How long a caller-presented guest id may be.
 *
 * @remarks A uuid is 36 characters; the slack exists so a malformed value is refused by the
 * *length* gate before anything parses it, and so the limit stays a form-side check the
 * browser can run without knowing what a uuid looks like.
 */
export const GUEST_ID_MAX_LENGTH = 64;

/**
 * A loose email shape for a first gate.
 *
 * @remarks Deliberately not a validator: the gateway answers `@IsEmail()` from class-validator,
 * and a stricter browser regex would refuse addresses the authority accepts. This pattern
 * only rejects what cannot work, so the page's refusal and the gateway's refusal never
 * disagree in the direction that matters.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- requests ----------------------------------------------------------------------

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface LogoutRequest {
  reason?: string;
  everywhere?: boolean;
}

export interface CreateUserRequest {
  email: string;
  displayName?: string;
  locale?: string;
}

/**
 * Registration: the account and its first password in one request.
 *
 * @remarks Unlike `CreateUserRequest`, this is not a provisioning call a stranger may aim at
 * an arbitrary account — the gateway creates the account from this body and sets the password
 * only on the account those two fields just produced, then signs the caller in. There is no
 * target id to tamper with, which is what makes it public without weakening
 * `POST /users/:id/password`'s permission check.
 */
export interface RegisterRequest {
  email: string;
  password: string;
  displayName?: string;
  locale?: string;
}

export interface SetPasswordRequest {
  password: string;
}

/**
 * The browser's placeholder account, presented back on the next visit.
 *
 * @remarks The id is a hint, never a claim: identity honours it only while the row behind it
 * still exists and is still a guest, and mints a fresh placeholder for anything else — an
 * unknown id, a reaped row, or the id of a real account. That refusal lives in identity so
 * every transport gets it; this field is the caller's best recollection, not its authority.
 */
export interface AcquireGuestUserRequest {
  userId?: string;
}

// ---- oauth -------------------------------------------------------------------------

/**
 * The identity providers this edge accepts.
 *
 * @remarks Three names, two shapes: `google` and `github` walk the redirect round trip
 * (start → provider → callback), while `telegram` has no start — its login widget *is* the
 * start and posts the browser straight to the callback with a signed payload.
 */
export const OAUTH_PROVIDERS = ['google', 'github', 'telegram'] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return (
    typeof value === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Which providers this deployment can actually start.
 *
 * @remarks A provider needs its client id, client secret, state secret and the public origin
 * its callback is registered under — all absent until an operator creates the OAuth app, so
 * the front reads this before it draws a button rather than sending everyone to a 503.
 *
 * @remarks Telegram's gate is its bot: `telegramBotUsername` is what the widget renders
 * with and is `null` exactly when `telegram` is `false`, so the front needs no second call
 * to draw (or withhold) the button.
 */
export interface OAuthProvidersResponse {
  google: boolean;
  github: boolean;
  telegram: boolean;
  telegramBotUsername: string | null;
}

// ---- responses ---------------------------------------------------------------------

export interface UserResponse {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerified: boolean;
}

/**
 * The caller, as `GET /auth/me` answers it — one type for every kind of caller.
 *
 * @remarks A signed-in account and a placeholder guest both reach `/auth/me`, and the
 * difference travels in `user.status` (`active`, `guest`) rather than in a second response
 * shape a client would have to branch on.
 *
 * @remarks `roles` and `permissions` are the live answer from access-control, read per
 * request: a token's claims are a snapshot taken at mint time, and "what could this caller
 * do an hour ago" is not the question anybody asked.
 */
export interface Principal {
  user: UserResponse;
  roles: string[];
  permissions: string[];
  /**
   * Which of the four actor kinds this caller is, strongest held role first.
   *
   * @remarks A convenience for rendering, not an authority: it is derived from
   * `user.status` and `roles` by the gateway, and every privileged action is still decided
   * by access-control on the server. A screen that hides a button for a `user` and shows it
   * for a `moderator` is a UX decision; the guard is what actually refuses the call.
   */
  actorKind: RoleKey;
  sessionId: string;
}

export interface LogoutResponse {
  sessionId: string;
  revokedCount: number;
}

export interface SetPasswordResponse {
  userId: string;
  credentialId: string;
}

// ---- role administration ---------------------------------------------------------------

/** A role as an operator sees it: what it confers, and whether the code owns it. */
export interface RoleSummary {
  readonly name: string;
  readonly permissions: readonly string[];
  readonly description: string | null;
  /** Seeded roles cannot be deleted or emptied; custom roles can. */
  readonly isSystem: boolean;
}

export interface RoleListResponse {
  readonly roles: readonly RoleSummary[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

/** The role to add or remove, named rather than indexed: a role has no surrogate id. */
export interface ChangeUserRoleRequest {
  readonly role: string;
}

/** The whole role set after the change, so a caller never has to reconcile a delta. */
export interface UserRolesResponse {
  readonly userId: string;
  readonly roles: readonly string[];
}

export interface AcquireGuestUserResponse {
  user: UserResponse;
}

/**
 * Every refusal the edge can produce, in the shape the edge actually sends.
 *
 * @remarks Two producers, two dialects: the gateway's error filter answers RFC 7807
 * (`detail` is the human sentence, `title` the code), and the front's own `/api/register`
 * handler answers `{ error }`. class-validator adds `message` — an array of field complaints
 * — on top of either. {@link apiErrorMessage} is the one place that flattens the difference,
 * so `error` and `detail` are each optional: neither producer guarantees the other's field.
 */
export interface ApiErrorResponse {
  statusCode?: number;
  message?: string | string[];
  error?: string;
  detail?: string;
  title?: string;
}

/** Narrows a parsed response body to the error shape. */
export function isApiErrorResponse(body: unknown): body is ApiErrorResponse {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as { error?: unknown; detail?: unknown; message?: unknown };
  return (
    typeof candidate.error === 'string' ||
    typeof candidate.detail === 'string' ||
    typeof candidate.message === 'string' ||
    Array.isArray(candidate.message)
  );
}

/**
 * The refusal to show: the detail the contract carries, or the caller's fallback.
 *
 * @remarks In order of specificity: `message` is the field complaint ("email must be a valid
 * address"), `detail` the gateway's own sentence ("the resource already exists"), `error`
 * the HTTP reason phrase ("Conflict") — and a body that is not a refusal this contract
 * knows (a proxy error, an empty body, a 500 without a body) falls back to the text the
 * screen shows instead.
 */
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (!isApiErrorResponse(body)) return fallback;
  if (typeof body.message === 'string' && body.message.length > 0) return body.message;
  if (Array.isArray(body.message) && body.message.length > 0) {
    return body.message.map(String).join(' ');
  }
  if (typeof body.detail === 'string' && body.detail.length > 0) return body.detail;
  if (typeof body.error === 'string' && body.error.length > 0) return body.error;
  return fallback;
}
