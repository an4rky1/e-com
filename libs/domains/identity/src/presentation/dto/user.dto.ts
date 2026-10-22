import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { UserReadModel } from '../../application/queries/user.queries';
import { UserStatus } from '../../domain/value-objects/user-status.vo';

export class CreateUserRequestDto {
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(10)
  locale?: string;
}

export class UpdateUserStatusRequestDto {
  @IsIn(['suspended', 'active'])
  status!: 'suspended' | 'active';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * Transport shape of a user.
 *
 * @remarks Built by a pure mapper rather than serialising the aggregate. The aggregate is a
 * domain object with invariants and a domain-event buffer; handing it to a response
 * serialiser is how internal fields end up on the wire and later become de facto API.
 */
export class UserResponseDto {
  id!: string;
  email!: string;
  displayName!: string | null;
  locale!: string;
  status!: string;
  emailVerified!: boolean;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;

  static from(user: UserReadModel): UserResponseDto {
    return toUserResponse(user);
  }
}

export function toUserResponse(user: UserReadModel): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    locale: user.locale,
    status: user.status,
    emailVerified: user.emailVerified,
    version: user.version,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export { UserStatus };