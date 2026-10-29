/**
 * @fileoverview Request bodies the edge accepts, and the responses it composes.
 *
 * @remarks The *shapes* and the *limits* come from `@auth/contracts/http` — the file the
 * front reads too — so a client and the gateway cannot disagree about what a well-formed
 * registration looks like. What stays here is the enforcement: `whitelist: true` on the
 * validation pipe means anything not declared in these classes is dropped before a handler
 * sees it, which for `POST /auth/login` is the difference between forwarding
 * `{ email, password, debug: true, note: "<the password>" }` upstream and forwarding only
 * the two fields the flow needs.
 *
 * @remarks No DTO here declares a field the caller may set on somebody else's behalf. The
 * routes that act for another user take that user from the path and their authority from
 * access-control.
 */
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  LOCALE_MAX_LENGTH,
  LOCALE_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  REFRESH_TOKEN_MAX_LENGTH,
  REFRESH_TOKEN_MIN_LENGTH,
  REASON_MAX_LENGTH,
} from '@auth/contracts/http';
import type {
  CreateUserRequest,
  CurrentUserResponse,
  LoginRequest,
  LogoutRequest,
  LogoutResponse,
  OAuthProvidersResponse,
  RefreshRequest,
  RegisterRequest,
  SetPasswordRequest,
  TokenPair,
  UserResponse,
} from '@auth/contracts/http';

export class LoginRequestDto implements LoginRequest {
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  /**
   * Declared, validated, forwarded and forgotten.
   *
   * @remarks The property name matters beyond style: it is in `SENSITIVE_FIELDS`, so the
   * platform filter redacts it even if a future handler passes the whole body into a log
   * context by accident.
   */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class RefreshRequestDto implements RefreshRequest {
  @IsString()
  @MinLength(REFRESH_TOKEN_MIN_LENGTH)
  @MaxLength(REFRESH_TOKEN_MAX_LENGTH)
  refreshToken!: string;
}

export class LogoutRequestDto implements LogoutRequest {
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX_LENGTH)
  reason?: string;

  /**
   * Sign out of every session, including this one.
   *
   * @remarks Off by default. The common case is "end this session"; `true` is the one that
   * makes the caller re-authenticate, so it is stated rather than assumed.
   */
  @IsOptional()
  everywhere?: boolean;
}

export class CreateUserRequestDto implements CreateUserRequest {
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(LOCALE_MIN_LENGTH)
  @MaxLength(LOCALE_MAX_LENGTH)
  locale?: string;
}

export class RegisterRequestDto implements RegisterRequest {
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  /**
   * The password field's counterpart to {@link LoginRequestDto.password}.
   *
   * @remarks The numbers here are the *edge's* gate — what a form may send — and not the
   * vault's policy, which the vault itself enforces and explains. That split is why
   * registration sets the credential before creating the account: a refusal on this field's
   * real rules lands on a password nothing points at, never on a half-made account.
   */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(LOCALE_MIN_LENGTH)
  @MaxLength(LOCALE_MAX_LENGTH)
  locale?: string;
}

export class SetPasswordRequestDto implements SetPasswordRequest {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

// ---- responses ---------------------------------------------------------------------
//
// Aliases, not shapes: the gateway's response types *are* the contract's types, so a handler
// returning one is checked against the same file a page reads it with.

export type TokenPairResponseDto = TokenPair;
export type UserResponseDto = UserResponse;
export type CurrentUserResponseDto = CurrentUserResponse;
export type LogoutResponseDto = LogoutResponse;
export type OAuthProvidersResponseDto = OAuthProvidersResponse;

/**
 * Stamps the token type onto a pair.
 *
 * @remarks RFC 6750 requires the scheme, and a client that has to remember it is a client
 * that can get it wrong.
 */
export function toTokenPairResponse(pair: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}): TokenPairResponseDto {
  return { ...pair, tokenType: 'Bearer' };
}

export function toUserResponse(user: {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerified: boolean;
}): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    emailVerified: user.emailVerified,
  };
}
