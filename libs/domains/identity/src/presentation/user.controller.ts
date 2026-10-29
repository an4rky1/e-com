import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { IdentityService } from '../application/facade/identity.service';
// Request DTOs are values on purpose: `emitDecoratorMetadata` reads the *value* binding of
// each `@Body()` parameter's type — a type-only binding emits `Function`, and
// ValidationPipe then strips the body to `{}` instead of validating it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreateUserRequestDto,
  UpdateUserStatusRequestDto,
  toUserResponse,
  type UserResponseDto,
} from './dto/user.dto';

/**
 * HTTP transport for identity.
 *
 * @remarks Talks only to {@link IdentityService}. It holds no business rule of its own — a
 * check that belongs in the aggregate does not belong here, where it would be bypassed by
 * the gRPC entry point.
 */
@Controller('users')
export class UserController {
  constructor(private readonly identity: IdentityService) {}

  @Post()
  async create(@Body() body: CreateUserRequestDto) {
    const id = await this.identity.createUser({
      email: body.email,
      displayName: body.displayName,
      locale: body.locale,
      source: 'web',
    });
    return toUserResponse(await this.identity.getUserById(id));
  }

  @Get()
  async list(@Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.identity.listUsers({
      status,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return toUserResponse(await this.identity.getUserById(id));
  }

  @Patch(':id/status')
  @HttpCode(204)
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserStatusRequestDto,
  ): Promise<void> {
    await this.identity.updateUserStatus({
      userId: id,
      status: body.status,
      reason: body.reason,
    });
  }

  @Post(':id/verify-email')
  @HttpCode(204)
  async verifyEmail(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.identity.verifyUserEmail(id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('reason') reason?: string,
  ): Promise<void> {
    await this.identity.deleteUser(id, reason);
  }
}