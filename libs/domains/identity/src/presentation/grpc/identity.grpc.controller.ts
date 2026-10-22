import { Controller } from '@nestjs/common';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import { GrpcMethod } from '@auth/infra/grpc';
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CreateUserRequest,
  CreateUserResponse,
  GetUserByEmailRequest,
  GetUserRequest,
  UserResponse,
  UpdateUserStatusRequest,
} from '@auth/contracts';
import { IdentityService } from '../../application/facade/identity.service';

const SERVICE = 'IdentityService';

/**
 * gRPC transport for identity.
 *
 * @remarks "Who is this?" is a question with a required answer, so it is a synchronous gRPC
 * call rather than an event. Every other service depends on this surface instead of reading
 * the database — which is what keeps the database private to identity.
 */
@Controller()
export class IdentityGrpcController {
  constructor(private readonly identity: IdentityService) {}

  @GrpcMethod(SERVICE, 'GetUser')
  async getUser(request: GetUserRequest): Promise<UserResponse> {
    return this.toGrpc(await this.identity.getUserById(request.userId));
  }

  @GrpcMethod(SERVICE, 'GetUserByEmail')
  async getUserByEmail(request: GetUserByEmailRequest): Promise<UserResponse> {
    const user = await this.identity.getUserByEmail(request.email);
    // gRPC has no "null", so a miss has to become an error. It has to be a *typed* one: the
    // exception filter maps a known code onto a gRPC status, and anything it does not
    // recognise becomes UNKNOWN — which a caller reads as "the dependency is broken" and
    // answers with 503 instead of 404. A hand-rolled `Object.assign(new Error(...), { code })`
    // is precisely that unrecognised shape.
    if (!user) {
      throw new ResourceNotFoundException('user not found', {
        email: request.email,
      });
    }
    return this.toGrpc(user);
  }

  @GrpcMethod(SERVICE, 'CreateUser')
  async createUser(request: CreateUserRequest): Promise<CreateUserResponse> {
    // The record and nothing else. No credential is stored here and no session is issued:
    // a caller that has just created an account still has to prove they own an address and
    // pick a password, and both of those belong to other services.
    const id = await this.identity.createUser({
      email: request.email,
      displayName: request.displayName || undefined,
      locale: request.locale || undefined,
      source: request.source || undefined,
    });

    return { user: this.toGrpc(await this.identity.getUserById(id)) };
  }

  @GrpcMethod(SERVICE, 'UpdateUserStatus')
  async updateUserStatus(request: UpdateUserStatusRequest): Promise<UserResponse> {
    await this.identity.updateUserStatus({
      userId: request.userId,
      status: request.status === 'suspended' ? 'suspended' : 'active',
      reason: request.reason,
    });
    return this.toGrpc(await this.identity.getUserById(request.userId));
  }

  /**
   * Resolves an opaque principal.
   *
   * @remarks Identity owns the user record but not the token store, so an access token is
   * validated by session-token and a session id by the session engine. This method reports
   * only the user it can prove, and leaves credential verification to its owner.
   */
  @GrpcMethod(SERVICE, 'Authenticate')
  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    // Without a verified principal there is nothing to resolve; the caller must authenticate
    // against session-token or api-key first.
    if (!request.accessToken && !request.sessionId && !request.apiKey) {
      return { authenticated: false, strategy: 'none', sessionId: '' };
    }

    return {
      authenticated: false,
      strategy: 'internal',
      sessionId: request.sessionId ?? '',
    };
  }

  private toGrpc(user: {
    id: string;
    email: string;
    displayName: string | null;
    status: string;
    emailVerified: boolean;
    version: number;
    createdAt: Date;
  }): UserResponse {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? '',
      status: user.status,
      emailVerified: user.emailVerified,
      roles: [],
      deleted: user.status === 'deleted',
      createdAt: user.createdAt.toISOString(),
    };
  }
}