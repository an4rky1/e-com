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
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PERMISSIONS } from '@auth/contracts';
import type { SetPasswordResponse } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Public, RequirePermissions } from './decorators/route-metadata';
import { Idempotent } from './decorators/idempotent';
// Values on purpose — the same `emitDecoratorMetadata` reasoning as in `auth.controller.ts`:
// a type-only body DTO emits `Function` as its parameter metatype, and ValidationPipe then
// strips the request to `{}` instead of validating it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreateUserRequestDto,
  SetPasswordRequestDto,
  toUserResponse,
} from './dto/gateway.dto';
import type { UserResponseDto } from './dto/gateway.dto';
// Value import on purpose — see the note in `auth.controller.ts`.
 // eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GatewayService } from '../application/facade/gateway.service';
import { USER_SOURCE_WEB } from '../application/user-source';

@Controller('users')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly gateway: GatewayService) {}

  /**
   * Creates the account record. The caller still has to set a password and sign in.
   *
   * @remarks `replay` rather than the `dedup` default: the answer is a plain record with
   * no credentials in it, so a retry whose first response was lost gets that response back
   * instead of a conflict it can do nothing with.
   */
  @Public()
  @Idempotent({ mode: 'replay' })
  @Post()
  async create(@Body() body: CreateUserRequestDto): Promise<UserResponseDto> {
    return toUserResponse(
      await this.gateway.createUser({
        email: body.email,
        displayName: body.displayName,
        locale: body.locale,
        // Recorded by identity for provenance. Never read back for an authorisation decision,
        // so it is a constant here rather than something a caller may choose.
        source: USER_SOURCE_WEB,
      }),
    );
  }

  /**
   * Reads one account. Moderators hold `users:read`; a shopper does not.
   *
   * @remarks The id is a path parameter rather than a query field because the account is the
   * resource. `ParseUUIDPipe` refuses a malformed id at the edge, so identity is never asked
   * a question that cannot name a row.
   */
  @Get(':id')
  @RequirePermissions(PERMISSIONS.USERS_READ)
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return toUserResponse(await this.gateway.getUser(id));
  }

  /**
   * Sets the initial password for an account.
   *
   * @remarks `users:password.set` is a name, not a rule. Which role carries it, and under
   * what conditions, is access-control's data.
   *
   * @remarks `replay`, because the answer is two identifiers and no secret — a retry of a
   * set that already succeeded can be handed that answer back instead of running the set
   * a second time against a credential the vault has already stored.
   */
  @RequirePermissions(PERMISSIONS.USERS_PASSWORD_SET)
  @Idempotent({ mode: 'replay' })
  @Post(':id/password')
  @HttpCode(200)
  async setPassword(
    @Param('id') id: string,
    @Body() body: SetPasswordRequestDto,
  ): Promise<SetPasswordResponse> {
    return this.gateway.setPassword({ userId: id, newPassword: body.password });
  }
}
