/**
 * @fileoverview Request bodies the edge accepts, and the responses it composes.
 *
 * @remarks `whitelist: true` on the validation pipe means anything not declared here is
 * dropped before a handler sees it. For `POST /auth/login` that is the difference between
 * forwarding `{ email, password, debug: true, note: "<the password>" }` upstream and
 * forwarding only the two fields the flow needs.
 *
 * @remarks No DTO here declares a field the caller may set on somebody else's behalf. The
 * routes that act for another user take that user from the path and their authority from
 * access-control.
 */
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginRequestDto {
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(254)
  email!: string;

  /**
   * Declared, validated, forwarded and forgotten.
   *
   * @remarks The property name matters beyond style: it is in `SENSITIVE_FIELDS`, so the
   * platform filter redacts it even if a future handler passes the whole body into a log
   * context by accident.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  password!: string;
}

export class RefreshRequestDto {
  @IsString()
  @MinLength(16)
  @MaxLength(4_096)
  refreshToken!: string;
}

export class LogoutRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
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

export class CreateUserRequestDto {
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(10)
  locale?: string;
}

export class SetPasswordRequestDto {
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  password!: string;
}

// ---- responses ---------------------------------------------------------------------

export interface TokenPairResponseDto {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  tokenType: 'Bearer';
}

export interface UserResponseDto {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerified: boolean;
}

export interface CurrentUserResponseDto {
  user: UserResponseDto;
  roles: string[];
  permissions: string[];
  sessionId: string;
}

export interface LogoutResponseDto {
  sessionId: string;
  revokedCount: number;
}

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
