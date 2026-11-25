/**
 * @fileoverview HTTP transport for role administration.
 *
 * @remarks The gateway is the only public edge, so the role catalogue and the grant/revoke
 * pair are reached here rather than by exposing access-control's own HTTP controller. The
 * routes carry no policy of their own: each names the permission it needs, and
 * `PermissionsGuard` asks access-control whether this caller holds it.
 *
 * @remarks `grantedBy` is never a body field. It is the authenticated principal, read after
 * `JwtAuthGuard` verified the bearer, so an operator cannot write somebody else's name into
 * the audit trail.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PERMISSIONS } from '@auth/contracts';
import type { RoleListResponse, UserRolesResponse } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { CurrentPrincipal } from './decorators/current-principal.decorator';
import { RequirePermissions } from './decorators/route-metadata';
import type { GatewayPrincipal } from '../application/ports/gateway-principal';
// Values on purpose — see the note in `auth.controller.ts`: a type-only body DTO emits
// `Function` as its parameter metatype, and ValidationPipe then strips the request to `{}`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ChangeUserRoleRequestDto, RoleListQueryDto } from './dto/gateway.dto';
// Value import on purpose — see the note in `auth.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GatewayService } from '../application/facade/gateway.service';

@Controller('access-control')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class RoleAdministrationController {
  constructor(private readonly gateway: GatewayService) {}

  /**
   * The roles a caller may grant.
   *
   * @remarks Includes the seeded roles: an operator needs to see what `user` and `moderator`
   * actually confer before handing either out. The permission is `roles:read`, not
   * `roles:grant` — reading the catalogue is not granting anything.
   */
  @Get('roles')
  @RequirePermissions(PERMISSIONS.ROLES_READ)
  async list(@Query() query: RoleListQueryDto): Promise<RoleListResponse> {
    const page = positiveOr(query.page, 1);
    const limit = positiveOr(query.limit, 20);
    const result = await this.gateway.listRoles({
      search: query.search?.trim() || undefined,
      page,
      limit,
    });

    return {
      roles: result.roles.map((role) => ({
        name: role.name,
        permissions: role.permissions,
        description: role.description,
        isSystem: role.isSystem,
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  /** Adds one role to one account, idempotently. */
  @Post('users/:userId/roles')
  @RequirePermissions(PERMISSIONS.ROLES_GRANT)
  @HttpCode(200)
  async grant(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: ChangeUserRoleRequestDto,
  ): Promise<UserRolesResponse> {
    return this.gateway.grantRole(principal, { userId, role: body.role });
  }

  /** Removes one role, idempotently: revoking what is already gone is still a success. */
  @Post('users/:userId/roles/revoke')
  @RequirePermissions(PERMISSIONS.ROLES_REVOKE)
  @HttpCode(200)
  async revoke(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: ChangeUserRoleRequestDto,
  ): Promise<UserRolesResponse> {
    return this.gateway.revokeRole({ userId, role: body.role });
  }
}

/** A query string that names a positive page; anything else falls back to the default. */
const positiveOr = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
