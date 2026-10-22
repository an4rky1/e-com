/**
 * @fileoverview HTTP transport for accounts.
 *
 * @remarks Two routes, and they are deliberately not the same kind of route. `POST /users`
 * is public — an account has to be creatable by someone who has no account yet, which is the
 * only way registration works. `POST /users/:id/password` is not: setting a password on an
 * account is a privileged act, so it declares the permission it needs and lets
 * `PermissionsGuard` settle it with access-control.
 *
 * @remarks The gateway never decides that the caller may set *their own* password. That would
 * be a second, edge-local copy of an authorization rule, and the copy is what drifts: revoke
 * the role in access-control and this shortcut would keep working.
 */
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Public, RequirePermissions } from './decorators/route-metadata';
import { toUserResponse } from './dto/gateway.dto';
import type {
  CreateUserRequestDto,
  SetPasswordRequestDto,
  UserResponseDto,
} from './dto/gateway.dto';
// Value import on purpose — see the note in `auth.controller.ts`.
 // eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GatewayService } from '../application/facade/gateway.service';

@Controller('users')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly gateway: GatewayService) {}

  /** Creates the account record. The caller still has to set a password and sign in. */
  @Public()
  @Post()
  async create(@Body() body: CreateUserRequestDto): Promise<UserResponseDto> {
    return toUserResponse(
      await this.gateway.createUser({
        email: body.email,
        displayName: body.displayName,
        locale: body.locale,
        // Recorded by identity for provenance. Never read back for an authorisation decision,
        // so it is a constant here rather than something a caller may choose.
        source: 'web',
      }),
    );
  }

  /**
   * Sets the initial password for an account.
   *
   * @remarks `users:password:set` is a name, not a rule. Which role carries it, and under
   * what conditions, is access-control's data.
   */
  @RequirePermissions('users:password:set')
  @Post(':id/password')
  @HttpCode(200)
  async setPassword(
    @Param('id') id: string,
    @Body() body: SetPasswordRequestDto,
  ): Promise<{ userId: string; credentialId: string }> {
    return this.gateway.setPassword({ userId: id, newPassword: body.password });
  }
}
