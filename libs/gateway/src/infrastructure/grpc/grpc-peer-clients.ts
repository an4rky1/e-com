/**
 * @fileoverview The five peers, over one channel.
 *
 * @remarks Each adapter takes a {@link PeerCaller} rather than a `GrpcChannel`, so no adapter
 * can forget the deadline or the error translation — both live one call away and are applied
 * by construction. They are also the only files in `libs/gateway` that name a gRPC method
 * path, which is what makes a renamed proto method a compile error rather than a runtime
 * "method is absent from the loaded proto definition" that only appears in production.
 *
 * @remarks Every request shape is spelled out rather than reused from a domain library. The
 * gateway cannot import `libs/domains/*` — that is the point of it — so these mirror
 * `libs/contracts/proto` one-to-one, exactly as `libs/contracts/src/grpc/service-contracts.ts`
 * does for the rest of the platform.
 */
import { Injectable } from '@nestjs/common';
import { InternalErrorException } from '@auth/platform/error-handling';
import type {
  CheckPermissionRequest,
  CheckPermissionResponse,
  CreateUserRequest,
  CreateUserResponse,
  FlowResponse,
  GetPermissionsRequest,
  GetPermissionsResponse,
  GetUserRequest,
  IssueTokensRequest,
  IssueTokensResponse,
  ResolveOauthUserRequest,
  ResolveOauthUserResponse,
  RotateTokensRequest,
  RotateTokensResponse,
  SetPasswordRequest,
  SetPasswordResponse,
  StartFlowRequest,
  AdvanceFlowRequest,
  UserResponse,
} from '@auth/contracts';
// Value import on purpose. Each adapter is registered with `useClass`, so Nest resolves it
// through `design:paramtypes` — which reads the *value* binding. `import type` would emit
// `Object` and the container would fail on the first of these five.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PeerCaller } from './peer-caller';
import type {
  AccessControlClientPort,
  AuthFlowClientPort,
  CredentialVaultClientPort,
  FlowProgress,
  GatewayUser,
  GatewayUserInput,
  IdentityClientPort,
  SessionClientPort,
} from '../../application/ports/peer-clients.port';

/** Full method paths, so a mistyped service name fails here rather than at the broker. */
const METHOD = {
  START_FLOW: '/auth_flow.v1.AuthFlowService/StartFlow',
  ADVANCE_FLOW: '/auth_flow.v1.AuthFlowService/AdvanceFlow',
  CREATE_USER: '/identity.v1.IdentityService/CreateUser',
  GET_USER: '/identity.v1.IdentityService/GetUser',
  RESOLVE_OAUTH_USER: '/identity.v1.IdentityService/ResolveOauthUser',
  GET_PERMISSIONS: '/access_control.v1.AccessControlService/GetPermissions',
  CHECK_PERMISSION: '/access_control.v1.AccessControlService/CheckPermission',
  ISSUE_TOKENS: '/session.v1.SessionService/IssueTokens',
  ROTATE_TOKENS: '/session.v1.SessionService/RotateTokens',
  REVOKE_SESSION: '/session.v1.SessionService/RevokeSession',
  REVOKE_ALL_SESSIONS: '/session.v1.SessionService/RevokeAllSessions',
  SET_PASSWORD: '/credential_vault.v1.CredentialVaultService/SetPassword',
  REVOKE_ALL_CREDENTIALS: '/credential_vault.v1.CredentialVaultService/RevokeAllCredentials',
} as const;

/**
 * Declared inline on `SessionGrpcClient` rather than exported by the contracts lib.
 *
 * @remarks `exceptSessionId` is the field that earns the duplication: it is what separates
 * "log out here" from "log out everywhere", and widening a shared contract for one caller
 * would be a wider change than this file is worth.
 */
interface RevokeAllSessionsRequest {
  userId: string;
  reason: string;
  exceptSessionId?: string;
}

interface RevokeAllSessionsResponse {
  revokedCount: number;
}

/** Mirrors the inline signature `CredentialVaultGrpcClient` spells for this call. */
interface RevokeAllCredentialsRequest {
  userId: string;
  reason: string;
}

interface RevokeAllCredentialsResponse {
  revokedCount: number;
}

@Injectable()
export class GrpcAuthFlowClient implements AuthFlowClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async startFlow(input: {
    email: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<FlowProgress> {
    const request: StartFlowRequest = {
      // The flow name is a fixed vocabulary, not a caller-supplied string: `/auth/login` is
      // the login flow, and letting the request body choose would make this endpoint a
      // front door to `reset_password`.
      flow: 'login',
      email: input.email,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    };

    return toFlowProgress(
      await this.peers.call<FlowResponse>(METHOD.START_FLOW, request),
    );
  }

  async advanceFlow(input: {
    flowId: string;
    credential: string;
    ipAddress?: string;
  }): Promise<FlowProgress> {
    const request: AdvanceFlowRequest = {
      flowId: input.flowId,
      credential: input.credential,
      ipAddress: input.ipAddress,
    };

    return toFlowProgress(
      await this.peers.call<FlowResponse>(METHOD.ADVANCE_FLOW, request),
    );
  }
}

@Injectable()
export class GrpcIdentityClient implements IdentityClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async createUser(input: GatewayUserInput): Promise<GatewayUser> {
    const request: CreateUserRequest = {
      email: input.email,
      displayName: input.displayName ?? '',
      locale: input.locale ?? '',
      source: input.source ?? '',
      // Absent is fine: identity treats an empty id as "generate one", which is the ordinary
      // provisioning path. Only registration pre-chooses, and only because its credential is
      // already stored under that id.
      id: input.id,
    };

    const response = await this.peers.call<CreateUserResponse>(
      METHOD.CREATE_USER,
      request,
    );

    // The proto has exactly one field, so a reply without it is a peer that answered
    // something other than what it promised. Asserted here rather than cast through: the
    // adapter is where a wire shape becomes an internal type, and this is the last place
    // the difference is visible.
    if (!response.user) {
      throw new InternalErrorException(
        undefined,
        { method: METHOD.CREATE_USER, reason: 'the reply carried no user' },
      );
    }

    return toGatewayUser(response.user);
  }

  async resolveOauthUser(input: {
    provider: string;
    subject: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
  }): Promise<{ user: GatewayUser; created: boolean }> {
    const request: ResolveOauthUserRequest = {
      provider: input.provider,
      subject: input.subject,
      email: input.email,
      emailVerified: input.emailVerified,
      displayName: input.displayName ?? '',
    };

    const response = await this.peers.call<ResolveOauthUserResponse>(
      METHOD.RESOLVE_OAUTH_USER,
      request,
    );

    if (!response.user) {
      throw new InternalErrorException(
        undefined,
        { method: METHOD.RESOLVE_OAUTH_USER, reason: 'the reply carried no user' },
      );
    }

    return { user: toGatewayUser(response.user), created: response.created };
  }

  async getUser(userId: string): Promise<GatewayUser> {
    const request: GetUserRequest = { userId };
    return toGatewayUser(
      await this.peers.call<UserResponse>(METHOD.GET_USER, request),
    );
  }
}

@Injectable()
export class GrpcAccessControlClient implements AccessControlClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async getPermissions(userId: string): Promise<{
    roles: readonly string[];
    permissions: readonly string[];
  }> {
    const request: GetPermissionsRequest = { userId };
    const response = await this.peers.call<GetPermissionsResponse>(
      METHOD.GET_PERMISSIONS,
      request,
    );
    return { roles: response.roles, permissions: response.permissions };
  }

  async checkPermission(input: {
    userId: string;
    permission: string;
  }): Promise<{ allowed: boolean; reason: string }> {
    const request: CheckPermissionRequest = {
      userId: input.userId,
      permission: input.permission,
    };
    const response = await this.peers.call<CheckPermissionResponse>(
      METHOD.CHECK_PERMISSION,
      request,
    );
    return { allowed: response.allowed, reason: response.reason };
  }
}

@Injectable()
export class GrpcSessionClient implements SessionClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async issueTokens(input: {
    userId: string;
    email: string;
    ipAddress?: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    sessionId: string;
  }> {
    const request: IssueTokensRequest = {
      userId: input.userId,
      email: input.email,
      ipAddress: input.ipAddress,
    };
    const response = await this.peers.call<IssueTokensResponse>(
      METHOD.ISSUE_TOKENS,
      request,
    );
    return {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresIn: response.expiresIn,
      sessionId: response.sessionId,
    };
  }

  async rotateTokens(input: {
    refreshToken: string;
    ipAddress?: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    sessionId: string;
    reuseDetected: boolean;
  }> {
    const request: RotateTokensRequest = {
      refreshToken: input.refreshToken,
      ipAddress: input.ipAddress,
    };
    const response = await this.peers.call<RotateTokensResponse>(
      METHOD.ROTATE_TOKENS,
      request,
    );

    return {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresIn: response.expiresIn,
      sessionId: response.sessionId,
      reuseDetected: response.reuseDetected,
    };
  }

  async revokeSession(input: { sessionId: string; reason: string }): Promise<boolean> {
    const response = await this.peers.call<{ ok: boolean }>(METHOD.REVOKE_SESSION, {
      sessionId: input.sessionId,
      reason: input.reason,
    });
    return response.ok;
  }

  async revokeAllSessions(input: {
    userId: string;
    reason: string;
    exceptSessionId?: string;
  }): Promise<number> {
    const request: RevokeAllSessionsRequest = {
      userId: input.userId,
      reason: input.reason,
      exceptSessionId: input.exceptSessionId,
    };
    const response = await this.peers.call<RevokeAllSessionsResponse>(
      METHOD.REVOKE_ALL_SESSIONS,
      request,
    );
    return response.revokedCount;
  }
}

@Injectable()
export class GrpcCredentialVaultClient implements CredentialVaultClientPort {
  constructor(private readonly peers: PeerCaller) {}

  async setPassword(input: {
    userId: string;
    newPassword: string;
  }): Promise<{ credentialId: string }> {
    const request: SetPasswordRequest = {
      userId: input.userId,
      newPassword: input.newPassword,
    };
    const response = await this.peers.call<SetPasswordResponse>(
      METHOD.SET_PASSWORD,
      request,
    );
    return { credentialId: response.credentialId };
  }

  async revokeAll(input: { userId: string; reason?: string }): Promise<number> {
    const request: RevokeAllCredentialsRequest = {
      userId: input.userId,
      reason: input.reason ?? 'revoked',
    };
    const response = await this.peers.call<RevokeAllCredentialsResponse>(
      METHOD.REVOKE_ALL_CREDENTIALS,
      request,
    );
    return response.revokedCount;
  }
}

// ---- mapping -----------------------------------------------------------------------

/**
 * A proto message always arrives with every field present.
 *
 * @remarks The loader runs with `defaults: true`, so an unset string is `''` rather than
 * `undefined`. Without this, a peer that omits `expiresIn` would answer `0` — indistinguishable
 * from a token that is already dead.
 */
function toFlowProgress(response: FlowResponse): FlowProgress {
  return {
    flowId: response.flowId,
    state: response.state,
    flow: response.flow,
    accessToken: response.accessToken || undefined,
    refreshToken: response.refreshToken || undefined,
    sessionId: response.sessionId || undefined,
    expiresIn: response.expiresIn || undefined,
    message: response.message || undefined,
    locked: response.locked || undefined,
    retryAfterSeconds: response.retryAfterSeconds || undefined,
  };
}

function toGatewayUser(user: UserResponse): GatewayUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    emailVerified: user.emailVerified,
    deleted: user.deleted,
    createdAt: user.createdAt,
  };
}
