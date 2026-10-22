import { ArrayMaxSize, IsArray, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import type { SessionReadModel } from '../../application/queries/session.queries';
import type { AccessTokenValidation } from '../../application/commands/validate-access-token.command';

export class IssueTokensRequestDto {
  @IsString()
  userId!: string;

  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ipAddress?: string;
}

export class RotateTokensRequestDto {
  @IsString()
  @MaxLength(512)
  refreshToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ipAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceId?: string;
}

export class RevokeAllSessionsRequestDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  exceptSessionId?: string;
}

export class ValidateAccessTokenRequestDto {
  @IsString()
  @MaxLength(8192)
  accessToken!: string;
}

/**
 * Transport shape of an issued token pair.
 *
 * @remarks `refreshToken` appears here and nowhere else: it is the only representation that
 * can authenticate anybody, so it must not leak into a log line, an error context or a
 * read model.
 */
export class IssuedTokensResponseDto {
  sessionId!: string;
  tokenFamilyId!: string;
  accessToken!: string;
  refreshToken!: string;
  expiresIn!: number;
  expiresAt!: string;
}

/**
 * Transport shape of a session.
 *
 * @remarks Note what is absent: no refresh token, no digest. The mapper is the boundary that
 * keeps them there.
 */
export class SessionResponseDto {
  id!: string;
  userId!: string;
  tokenFamilyId!: string;
  deviceId!: string | null;
  status!: string;
  expiresAt!: Date;
  refreshExpiresAt!: Date;
  revokedAt!: Date | null;
  revokeReason!: string | null;
  clientIp!: string | null;
  userAgent!: string | null;
  version!: number;
  refreshTokenCount!: number;
  activeRefreshTokenId!: string | null;
  createdAt!: Date;

  static from(session: SessionReadModel): SessionResponseDto {
    return toSessionResponse(session);
  }
}

export class AccessTokenValidationResponseDto {
  valid!: boolean;
  userId!: string;
  email!: string;
  roles!: string[];
  permissions!: string[];
  sessionId!: string;
  revocationReason!: string;
}

export function toSessionResponse(session: SessionReadModel): SessionResponseDto {
  return {
    id: session.id,
    userId: session.userId,
    tokenFamilyId: session.tokenFamilyId,
    deviceId: session.deviceId,
    status: session.status,
    expiresAt: session.expiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
    revokedAt: session.revokedAt,
    revokeReason: session.revokeReason,
    clientIp: session.clientIp,
    userAgent: session.userAgent,
    version: session.version,
    refreshTokenCount: session.refreshTokenCount,
    activeRefreshTokenId: session.activeRefreshTokenId,
    createdAt: session.createdAt,
  };
}

export function toValidationResponse(
  validation: AccessTokenValidation,
): AccessTokenValidationResponseDto {
  return {
    valid: validation.valid,
    userId: validation.userId,
    email: validation.email,
    roles: validation.roles,
    permissions: validation.permissions,
    sessionId: validation.sessionId,
    revocationReason: validation.revocationReason,
  };
}