import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
// A value import on purpose: `design:paramtypes` has to resolve the injected class at
// runtime, and a type-only specifier is erased before the metadata is emitted.
import { SessionTokenService } from '../application/facade/session-token.service';
import {
  toSessionResponse,
  toValidationResponse,
} from './dto/session.dto';
import type {
  AccessTokenValidationResponseDto,
  IssueTokensRequestDto,
  IssuedTokensResponseDto,
  RevokeAllSessionsRequestDto,
  RotateTokensRequestDto,
  SessionResponseDto,
  ValidateAccessTokenRequestDto,
} from './dto/session.dto';

/**
 * HTTP transport for session-token.
 *
 * @remarks Talks only to {@link SessionTokenService}. It holds no business rule of its own — a
 * check that belongs in the aggregate does not belong here, where it would be bypassed by the
 * gRPC entry point.
 */
@Controller('sessions')
export class SessionController {
  constructor(private readonly sessionToken: SessionTokenService) {}

  @Post('tokens')
  async issue(@Body() body: IssueTokensRequestDto): Promise<IssuedTokensResponseDto> {
    const pair = await this.sessionToken.issueTokens({
      userId: body.userId,
      email: body.email,
      roles: body.roles,
      permissions: body.permissions,
      deviceId: body.deviceId,
      ipAddress: body.ipAddress,
    });

    // Returned verbatim: this is the only response that carries a refresh token, and there is
    // nothing to map — every field already has its transport name.
    return pair;
  }

  @Post('tokens/rotate')
  async rotate(@Body() body: RotateTokensRequestDto): Promise<IssuedTokensResponseDto> {
    return this.sessionToken.rotateTokens({
      refreshToken: body.refreshToken,
      ipAddress: body.ipAddress,
      deviceId: body.deviceId,
    });
  }

  @Post('tokens/validate')
  async validate(
    @Body() body: ValidateAccessTokenRequestDto,
  ): Promise<AccessTokenValidationResponseDto> {
    return toValidationResponse(
      await this.sessionToken.validateAccessToken(body.accessToken),
    );
  }

  @Get(':id')
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SessionResponseDto> {
    return toSessionResponse(await this.sessionToken.getSessionById(id));
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('reason') reason?: string,
  ): Promise<void> {
    await this.sessionToken.revokeSession(id, reason);
  }

  @Post('revoke-all')
  @HttpCode(200)
  async revokeAll(
    @Body() body: RevokeAllSessionsRequestDto,
  ): Promise<{ revokedCount: number }> {
    const result = await this.sessionToken.revokeAllSessions({
      userId: body.userId,
      reason: body.reason,
      exceptSessionId: body.exceptSessionId,
    });
    return { revokedCount: result.revokedCount };
  }
}