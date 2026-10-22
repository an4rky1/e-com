import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import {
  NotDeleted,
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../../domain/ports/user-repository.port';
import type { User } from '../../domain/user.aggregate';

// ---- read model -----------------------------------------------------------------

/**
 * Projection of the aggregate for callers.
 *
 * @remarks A distinct type rather than returning `User` itself: the aggregate carries
 * invariants and a domain-event buffer, and exposing it makes those internals part of the
 * module's contract.
 */
export interface UserReadModel {
  id: string;
  email: string;
  displayName: string | null;
  locale: string;
  status: string;
  emailVerified: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export const toReadModel = (user: User): UserReadModel => ({
  id: user.id,
  email: user.email.value,
  displayName: user.displayName,
  locale: user.locale,
  status: user.status,
  emailVerified: user.emailVerified,
  version: user.version,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  deletedAt: user.deletedAt,
});

// ---- queries --------------------------------------------------------------------

export class GetUserByIdQuery extends Query<UserReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly userId: string) {
    super();
  }
}

@Injectable()
@QueryHandler(GetUserByIdQuery)
export class GetUserByIdHandler
  implements IQueryHandler<GetUserByIdQuery, UserReadModel>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(query: GetUserByIdQuery): Promise<UserReadModel> {
    const user = await this.users.findById(query.userId);
    if (!user) {
      throw new ResourceNotFoundException('user not found', {
        userId: query.userId,
      });
    }
    return toReadModel(user);
  }
}

export class GetUserByEmailQuery extends Query<UserReadModel | null> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly email: string) {
    super();
  }
}

@Injectable()
@QueryHandler(GetUserByEmailQuery)
export class GetUserByEmailHandler
  implements IQueryHandler<GetUserByEmailQuery, UserReadModel | null>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  /**
   * Returns `null` rather than throwing.
   *
   * @remarks This backs sign-in, which must report the same answer for "no such user" and
   * "wrong password" to the caller. Distinguishing them for the caller would confirm which
   * addresses have accounts.
   */
  async execute(query: GetUserByEmailQuery): Promise<UserReadModel | null> {
    const user = await this.users.findByEmail(query.email);
    return user ? toReadModel(user) : null;
  }
}

export interface PagedUsers {
  data: UserReadModel[];
  total: number;
  page: number;
  limit: number;
}

export class ListUsersQuery extends Query<PagedUsers> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly status?: string,
    readonly page?: number,
    readonly limit?: number,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(ListUsersQuery)
export class ListUsersHandler
  implements IQueryHandler<ListUsersQuery, PagedUsers>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(query: ListUsersQuery): Promise<PagedUsers> {
    // Soft-deleted rows are excluded: a deleted user must not appear in an operator listing
    // unless explicitly requested.
    const spec = new NotDeleted();
    const all = await this.users.find(spec);
    const total = await this.users.count(spec);

    const filtered = query.status
      ? all.filter((user) => user.status === query.status)
      : all;

    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    return {
      data: filtered.slice(offset, offset + limit).map(toReadModel),
      total: query.status ? filtered.length : total,
      page,
      limit,
    };
  }
}