/**
 * @fileoverview HTTP transport for authentication.
 *
 * @remarks Both guards are mounted on the controller, in order, and `@Public()` opts a route
 * out of them. That arrangement is what makes the whole surface auditable from one file: a
 * reader can see which routes are reachable without a token and which are not, without
 * opening the guards.
 *
 * @remarks Nothing here holds state and nothing here decides anything. Each handler names a
 * use case and hands back what it returned.
 */
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Public } from './decorators/route-metadata';
import {
  ClientIp,
  ClientUserAgent,
  CurrentPrincipal,
} from './decorators/current-principal.decorator';
import { toTokenPairResponse, toUserResponse } from './dto/gateway.dto';
// Type-only positions: Nest reads a request body's *type* from the method signature, and a
// DTO class needs nothing at runtime here.
import type {
  CurrentUserResponseDto,
  LoginRequestDto,
  LogoutRequestDto,
  LogoutResponseDto,
  RefreshRequestDto,
  TokenPairResponseDto,
} from './dto/gateway.dto';
import type { GatewayPrincipal } from '../application/ports/gateway-principal';
// Value import on purpose. `emitDecoratorMetadata` reads the *value* binding of each
// constructor parameter's type, so `import type { GatewayService }` compiles, lints clean and
// then fails at boot with "Nest can't resolve dependencies of the AuthGateway (?)". The
// eslint rule that suggests the rewrite is wrong here, hence the disable.
 // eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GatewayService } from '../application/facade/gateway.service';

@Controller('auth')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class AuthController {
  constructor(private readonly gateway: GatewayService) {}

  /**
   * Signs in with an address and a password.
   *
   * @remarks `@Public()` is not decoration. The guard denies by default, so without it this
   * route could not be reached by the very people who have no token yet.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginRequestDto,
    @ClientIp() ipAddress?: string,
    @ClientUserAgent() userAgent?: string,
  ): Promise<TokenPairResponseDto> {
    // `body` is destructured into the four arguments the use case takes, so the password
    // stops existing as part of a larger object the moment the call is made.
    const result = await this.gateway.login({
      email: body.email,
      password: body.password,
      ipAddress,
      userAgent,
    });

    return toTokenPairResponse(result);
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * @remarks Also `@Public()`: the refresh token *is* the credential here, and the caller
   * reaching this route is by definition one whose access token has expired.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: RefreshRequestDto,
    @ClientIp() ipAddress?: string,
  ): Promise<TokenPairResponseDto> {
    return toTokenPairResponse(
      await this.gateway.refresh({ refreshToken: body.refreshToken, ipAddress }),
    );
  }

  /**
   * Ends the caller's session, or every session they have.
   *
   * @remarks Both fields are read through `?.` because `@Body()` is `undefined` when the
   * request carries no body at all — a logout with no payload is the ordinary case, and
   * `body.reason ?? 'logout'` throws on it, turning a successful logout into a 500 while the
   * session it should have ended stays alive.
   */
  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Body() body?: LogoutRequestDto,
  ): Promise<LogoutResponseDto> {
    return this.gateway.logout(principal, {
      reason: body?.reason ?? 'logout',
      everywhere: body?.everywhere === true,
    });
  }

  /**
   * The caller's profile and their live authorisations, composed from two services.
   *
   * @remarks The access token has already been validated by `JwtAuthGuard` — that is what
   * produced the principal this handler is handed — so this route composes what validation
   * did not carry rather than validating a second time.
   */
  @Get('me')
  async me(
    @CurrentPrincipal() principal: GatewayPrincipal,
  ): Promise<CurrentUserResponseDto> {
    const current = await this.gateway.me(principal);

    return {
      user: toUserResponse(current.user),
      roles: [...current.roles],
      permissions: [...current.permissions],
      sessionId: current.sessionId,
    };
  }
}
