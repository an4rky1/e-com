import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
// Value import: constructor-injected. `emitDecoratorMetadata` reads the emitted value
// binding, so a type-only import erases the DI token and Nest cannot resolve it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { AccessControlService } from '../application/facade/access-control.service';
import { AccessControlGuard } from './guards/access-control.guard';
import { RequirePermissions } from './decorators/require-permissions.decorator';
import {
  type CreatePolicyRequestDto,
  type CreateRoleRequestDto,
  type GrantRoleRequestDto,
  type ListRolesQueryDto,
  type RevokeRoleRequestDto,
  attributesContextFrom,
  PagedRolesResponseDto,
  toRoleResponse,
  toUserPermissionsResponse,
  type PermissionDecisionResponseDto,
  type RoleResponseDto,
  type UserPermissionsResponseDto,
} from './dto/access-control.dto';

/**
 * HTTP transport for access control.
 *
 * @remarks Talks only to {@link AccessControlService}. It holds no business rule of its own —
 * a check that belongs in the aggregate or the evaluator does not belong here, where it would
 * be bypassed by the gRPC entry point.
 *
 * @remarks The routes are administrative and every one of them is guarded by the same
 * permission that names it. That is not decoration: an endpoint that changes who may do what,
 * with no check of its own, is a privilege escalation with an HTTP verb attached.
 */
@Controller('access-control')
@UseGuards(AccessControlGuard)
export class AccessControlController {
  constructor(private readonly accessControl: AccessControlService) {}

  @Post('roles')
  @RequirePermissions('roles:write')
  async createRole(@Body() body: CreateRoleRequestDto): Promise<RoleResponseDto> {
    const name = await this.accessControl.createRole({
      name: body.name,
      permissions: body.permissions,
      description: body.description,
    });

    const roles = await this.accessControl.listRoles({ search: name, limit: 1 });
    const created = roles.data.find((role) => role.name === name);
    if (!created) {
      // Unreachable in practice: the role was just written. Returning something rather than
      // throwing keeps a read-after-write race from surfacing as a 500 to the caller.
      throw new Error(`role "${name}" was created but could not be read back`);
    }

    return toRoleResponse(created);
  }

  @Get('roles')
  @RequirePermissions('roles:read')
  async listRoles(@Query() query: ListRolesQueryDto): Promise<PagedRolesResponseDto> {
    return PagedRolesResponseDto.from(
      await this.accessControl.listRoles({
        search: query.search,
        includeSystem: query.includeSystem === undefined
          ? undefined
          : query.includeSystem !== 'false',
        page: query.page ? Number(query.page) : undefined,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    );
  }

  @Post('users/:userId/roles')
  @RequirePermissions('roles:grant')
  async grantRole(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: GrantRoleRequestDto,
  ): Promise<UserPermissionsResponseDto> {
    await this.accessControl.grantRoleToUser({
      userId,
      role: body.role,
      grantedBy: body.grantedBy,
      reason: body.reason,
      // A temporary grant is the common case in support tooling: "let them do this for an
      // hour" must not need a second call to take back.
      expiresAt: body.temporary
        ? new Date(Date.now() + TEMPORARY_GRANT_MS)
        : null,
    });

    return toUserPermissionsResponse(
      await this.accessControl.getUserPermissions(userId),
    );
  }

  @Delete('users/:userId/roles')
  @RequirePermissions('roles:revoke')
  @HttpCode(204)
  async revokeRole(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: RevokeRoleRequestDto,
  ): Promise<void> {
    await this.accessControl.revokeRoleFromUser({
      userId,
      role: body.role,
      reason: body.reason,
    });
  }

  @Post('policies')
  @RequirePermissions('policies:write')
  async createPolicy(@Body() body: CreatePolicyRequestDto) {
    const policyId = await this.accessControl.createPolicy({
      role: body.role,
      permission: body.permission,
      effect: body.effect,
      conditions: body.conditions,
      priority: body.priority,
      resourceType: body.resourceType,
      description: body.description,
    });

    return { policyId };
  }

  @Delete('policies/:policyId')
  @RequirePermissions('policies:write')
  @HttpCode(204)
  async deletePolicy(
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Query('reason') reason?: string,
  ): Promise<void> {
    await this.accessControl.deletePolicy({ policyId, reason });
  }

  @Get('users/:userId/permissions')
  @RequirePermissions('users:read')
  async getPermissions(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<UserPermissionsResponseDto> {
    return toUserPermissionsResponse(
      await this.accessControl.getUserPermissions(userId),
    );
  }

  /**
   * Evaluates one permission against the caller's context.
   *
   * @remarks Returns 200 with `allowed: false` rather than 403. This is a *question*, asked
   * by something that is itself allowed to ask; the caller's own access is decided by the
   * guard above, and conflating the two turns a diagnostic into an error.
   */
  @Get('users/:userId/permissions/:permission')
  @RequirePermissions('users:read')
  async checkPermission(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('permission') permission: string,
    @Req() request: unknown,
    @Headers('x-tenant-id') tenant?: string,
  ): Promise<PermissionDecisionResponseDto> {
    const context = attributesContextFrom(request);

    const decision = await this.accessControl.checkPermission({
      userId,
      permission,
      context: tenant === undefined ? context : { ...context, tenant },
    });

    return { allowed: decision.allowed, reason: decision.reason };
  }
}

/** One hour: long enough for a support session, short enough to expire unattended. */
const TEMPORARY_GRANT_MS = 60 * 60 * 1_000;