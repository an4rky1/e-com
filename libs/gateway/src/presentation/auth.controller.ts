/**
 * @fileoverview HTTP transport for authentication.
 *
 * @remarks The guards are mounted on the controller, in order, and two decorators say what
 * a route needs. `@Public()` means no *bearer* is required to reach it; `@AllowGuest()` means
 * a validated `X-Guest-Id` counts as the identity when there is no bearer, and
 * `GuestIdentityGuard` — mounted here too, and acting only on routes so marked — is what
 * turns that header into a principal. That arrangement is what makes the whole surface
 * auditable from one file: a reader can see which routes are reachable without a bearer,
 * which accept a guest id, and which demand a session, without opening the guards.
 *
 * @remarks Nothing here holds state and nothing here decides anything. Each handler names a
 * use case and hands back what it returned.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GuestIdentityGuard } from './guards/guest-identity.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { AllowGuest, Public } from './decorators/route-metadata';
import { Idempotent } from './decorators/idempotent';
import {
  ClientIp,
  ClientUserAgent,
  CurrentPrincipal,
} from './decorators/current-principal.decorator';
// The request DTOs are values on purpose: `emitDecoratorMetadata` reads the *value* binding
// of each `@Body()` parameter's type, so `import type` compiles clean, lints clean, and then
// hands ValidationPipe `Function` as the metatype — which strips the body to `{}` and skips
// validation, turning a sign-in into a request that carries no credentials. Response shapes
// stay type-only below: nothing reads those at runtime.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AcquireGuestUserRequestDto,
  LoginRequestDto,
  LogoutRequestDto,
  RegisterRequestDto,
  RefreshRequestDto,
  toTokenPairResponse,
  toUserResponse,
} from './dto/gateway.dto';
import type {
  AcquireGuestUserResponseDto,
  LogoutResponseDto,
  OAuthProvidersResponseDto,
  PrincipalDto,
  TokenPairResponseDto,
} from './dto/gateway.dto';
import type { GatewayPrincipal } from '../application/ports/gateway-principal';
// Value import on purpose. `emitDecoratorMetadata` reads the *value* binding of each
// constructor parameter's type, so `import type { GatewayService }` compiles, lints clean and
// then fails at boot with "Nest can't resolve dependencies of the AuthFlow (?)". The
// eslint rule that suggests the rewrite is wrong here, hence the disable.
 // eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GatewayService } from '../application/facade/gateway.service';
// Same value-import reasoning as above: OAuthService is a constructor dependency.
 // eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { OAuthService } from '../application/oauth/oauth.service';

@Controller('auth')
@UseGuards(RateLimitGuard, JwtAuthGuard, GuestIdentityGuard, PermissionsGuard)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly gateway: GatewayService,
    private readonly oauth: OAuthService,
  ) {}

  /**
   * Signs in with an address and a password.
   *
   * @remarks `@Public()` is not decoration. The guard denies by default, so without it this
   * route could not be reached by the very people who have no token yet.
   *
   * @remarks `@Idempotent()` without a mode is `dedup`: a retried sign-in runs once or is
   * refused with a conflict, and is never answered from a cache — the answer is a token
   * pair, and Redis is not where tokens live.
   */
  @Public()
  @Idempotent()
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
   * Creates an account and its first password, and signs the caller in.
   *
   * @remarks Public for the same reason login is: the people who need it have no token yet.
   * What keeps it from being a provisioning hole is that there is no target — the body
   * carries an address and a password, the gateway picks the account, and
   * `POST /users/:id/password` keeps its permission check untouched. The 200 rather than 201
   * is deliberate: the meaningful answer here is the session, not the row.
   *
   * @remarks `dedup` for the same reason as login: the answer is a session, so a retry that
   * arrives after the first one completed is refused rather than replayed.
   */
  @Public()
  @Idempotent()
  @Post('register')
  @HttpCode(200)
  async register(
    @Body() body: RegisterRequestDto,
    @ClientIp() ipAddress?: string,
  ): Promise<TokenPairResponseDto> {
    const result = await this.gateway.register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      locale: body.locale,
      ipAddress,
    });

    return toTokenPairResponse(result);
  }

  /**
   * The browser's placeholder account: renewed when it presents an id that still names a
   * live guest row, minted fresh otherwise.
   *
   * @remarks `@Public()` because the caller by definition has no token — an anonymous shopper
   * asking for an identity to hold between visits. What keeps this from being an account
   * minting hole aimed at anyone is not the guard but identity: the presented id is a hint
   * honoured only while it still names a live guest row, so no body here can be pointed at a
   * real account, and the answer to every refusal is a fresh placeholder rather than a 4xx.
   *
   * @remarks `replay` for the same reason createUser takes it: a double-tap that carries one
   * idempotency key gets the first placeholder back instead of stranding a second — the
   * reaper would collect the orphan eventually either way, but a browser that can only keep
   * one id should never have to learn which of two it was handed.
   */
  @Public()
  @Idempotent({ mode: 'replay' })
  @Post('guest')
  @HttpCode(200)
  async acquireGuestUser(
    @Body() body: AcquireGuestUserRequestDto,
  ): Promise<AcquireGuestUserResponseDto> {
    const guest = await this.gateway.acquireGuestUser(body.userId);

    return { user: toUserResponse(guest) };
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * @remarks Also `@Public()`: the refresh token *is* the credential here, and the caller
   * reaching this route is by definition one whose access token has expired.
   *
   * @remarks `dedup` matters most here: rotation consumes the presented token, so a retry
   * that ran the exchange twice would either fail on an already-used token or — worse, if
   * the peer were lenient — mint two sessions from one credential.
   */
  @Public()
  @Idempotent()
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
   * @remarks Both kinds of caller reach this. A bearer, whose principal `JwtAuthGuard`
   * produced by verifying the token — and, because the route is `@AllowGuest()`, an
   * anonymous browser whose validated `X-Guest-Id` `GuestIdentityGuard` turned into a
   * session-only principal. Either way the handler composes what producing that principal
   * did not carry, rather than validating a second time.
   *
   * @remarks `@Public()` here says only that a bearer is *optional*, not that the route is
   * anonymous: with neither credential present, `GuestIdentityGuard` refuses the request
   * before this handler runs.
   */
  @Public()
  @AllowGuest()
  @Get('me')
  async me(
    @CurrentPrincipal() principal: GatewayPrincipal,
  ): Promise<PrincipalDto> {
    const current = await this.gateway.me(principal);

    return {
      user: toUserResponse(current.user),
      roles: [...current.roles],
      permissions: [...current.permissions],
      actorKind: current.actorKind,
      sessionId: current.sessionId,
    };
  }

  /**
   * Which providers this deployment can start — read by the front before it draws a button.
   *
   * @remarks Declared before the parameterised route below on purpose: Nest resolves in
   * registration order, so `/auth/oauth` has to be claimed before `:provider` could swallow
   * it as a provider named "oauth".
   */
  @Public()
  @Get('oauth')
  oauthProviders(): OAuthProvidersResponseDto {
    return this.oauth.providers();
  }

  /**
   * Hands the browser to the provider.
   *
   * @remarks A redirect rather than a JSON answer: this route's caller is a navigation, and
   * a body it would have to read and act on would put the state-minting decision in a page
   * instead of in the edge that signs it.
   */
  @Public()
  @Get('oauth/:provider')
  oauthStart(
    @Param('provider') provider: string,
    @Res() response: Response,
  ): void {
    response.redirect(302, this.oauth.start(provider));
  }

  /**
   * The provider's return: verify, exchange, resolve, issue, and land the browser home.
   *
   * @remarks Every outcome — including every refusal — ends in a redirect to the front with
   * the answer in the fragment, because the caller here is a browser following a link: an
   * exception rendered as JSON would leave a person staring at a status code. The failure is
   * logged with its message (this platform's messages are written to be read) while the
   * browser gets the same text to display.
   */
  @Public()
  @Get('oauth/:provider/callback')
  async oauthCallback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    // The whole query, unshaped: Telegram signs *every* field it sent, so the verification
    // has to see exactly what arrived — picking fields here would drop the ones the
    // data-check-string was built from.
    @Query() query: Record<string, string | string[]>,
    @ClientIp() ipAddress: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const result = await this.oauth.callback({
        provider,
        code,
        state,
        telegramQuery: query,
        ipAddress,
      });
      response.redirect(302, this.oauth.successRedirect(result));
    } catch (error) {
      this.logger.warn(
        `oauth callback for "${provider.slice(0, 32)}" refused: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      response.redirect(302, this.oauth.failureRedirect(error));
    }
  }
}
