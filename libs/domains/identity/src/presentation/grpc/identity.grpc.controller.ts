import { Controller } from '@nestjs/common';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CreateUserRequest,
  CreateUserResponse,
  GetUserByEmailRequest,
  GetUserRequest,
  ResolveOauthUserRequest,
  ResolveOauthUserResponse,
  UserResponse,
  UpdateUserStatusRequest,
} from '@auth/contracts';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { IdentityService } from '../../application/facade/identity.service';

const SERVICE = 'IdentityService';

/**
 * gRPC transport for identity.
 *
 * @remarks "Who is this?" is a question with a required answer, so it is a synchronous gRPC
 * call rather than an event. Every other service depends on this surface instead of reading
 * the database — which is what keeps the database private to identity.
 *
 * @remarks It extends {@link GrpcControllerBase} for the same reason the other transports do:
 * the base carries the service-token guard, and a controller that does not extend it serves
 * this port — `GetUser`, `SetPassword`'s neighbour — to anything that can reach the address.
 */
@Controller()
export class IdentityGrpcController extends GrpcControllerBase {
  constructor(private readonly identity: IdentityService) {
    super();
  }

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
      emailVerified: request.emailVerified === true,
      id: request.id || undefined,
    });

    return { user: this.toGrpc(await this.identity.getUserById(id)) };
  }

  /**
   * Resolves a provider account to a local user.
   *
   * @remarks The decision — link by identity, link by address, or create — is identity's,
   * made where the linkage lives. The caller carries only what the provider vouched for; it
   * does not get to choose which of the three outcomes happens.
   */
  @GrpcMethod(SERVICE, 'ResolveOauthUser')
  async resolveOauthUser(
    request: ResolveOauthUserRequest,
  ): Promise<ResolveOauthUserResponse> {
    const resolved = await this.identity.resolveOauthUser({
      provider: request.provider,
      subject: request.subject,
      email: request.email,
      emailVerified: request.emailVerified === true,
      displayName: request.displayName || undefined,
    });

    return {
      user: this.toGrpc(await this.identity.getUserById(resolved.userId)),
      created: resolved.created,
    };
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
   * validated by session and a session id by the session engine. This method reports
   * only the user it can prove, and leaves credential verification to its owner.
   */
  @GrpcMethod(SERVICE, 'Authenticate')
  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    // Without a verified principal there is nothing to resolve; the caller must authenticate
    // against session or api-key first.
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