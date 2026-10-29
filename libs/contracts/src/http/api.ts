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
import type { TokenPair } from '../auth.types';

export type { TokenPair };

// ---- field limits, shared by both gates -------------------------------------------

export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 512;
export const REFRESH_TOKEN_MIN_LENGTH = 16;
export const REFRESH_TOKEN_MAX_LENGTH = 4_096;
export const DISPLAY_NAME_MAX_LENGTH = 200;
export const LOCALE_MIN_LENGTH = 2;
export const LOCALE_MAX_LENGTH = 10;
export const REASON_MAX_LENGTH = 200;

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

export interface CurrentUserResponse {
  user: UserResponse;
  roles: string[];
  permissions: string[];
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
