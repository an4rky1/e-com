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
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { SessionService } from '../application/facade/session.service';
import {
  toSessionResponse,
  toValidationResponse,
} from './dto/session.dto';
// Request DTOs are values on purpose: `emitDecoratorMetadata` reads the *value* binding of
// each `@Body()` parameter's type — a type-only binding emits `Function` in its place, and
// ValidationPipe then strips the body to `{}` instead of validating it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  IssueTokensRequestDto,
  RevokeAllSessionsRequestDto,
  RotateTokensRequestDto,
  ValidateAccessTokenRequestDto,
} from './dto/session.dto';
import type {
  AccessTokenValidationResponseDto,
  IssuedTokensResponseDto,
  SessionResponseDto,
} from './dto/session.dto';

/**
 * HTTP transport for session.
 *
 * @remarks Talks only to {@link SessionService}. It holds no business rule of its own — a
 * check that belongs in the aggregate does not belong here, where it would be bypassed by the
 * gRPC entry point.
 */
@Controller('sessions')
export class SessionController {
  constructor(private readonly session: SessionService) {}

  @Post('tokens')
  async issue(@Body() body: IssueTokensRequestDto): Promise<IssuedTokensResponseDto> {
    const pair = await this.session.issueTokens({
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
    return this.session.rotateTokens({
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
      await this.session.validateAccessToken(body.accessToken),
    );
  }

  @Get(':id')
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SessionResponseDto> {
    return toSessionResponse(await this.session.getSessionById(id));
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('reason') reason?: string,
  ): Promise<void> {
    await this.session.revokeSession(id, reason);
  }

  @Post('revoke-all')
  @HttpCode(200)
  async revokeAll(
    @Body() body: RevokeAllSessionsRequestDto,
  ): Promise<{ revokedCount: number }> {
    const result = await this.session.revokeAllSessions({
      userId: body.userId,
      reason: body.reason,
      exceptSessionId: body.exceptSessionId,
    });
    return { revokedCount: result.revokedCount };
  }
}