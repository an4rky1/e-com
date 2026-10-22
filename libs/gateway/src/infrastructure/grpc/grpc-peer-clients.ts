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
  RotateTokensRequest,
  RotateTokensResponse,
  SetPasswordRequest,
  SetPasswordResponse,
  StartFlowRequest,
  AdvanceFlowRequest,
  UserResponse,
  ValidateAccessTokenResponse,
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
  START_FLOW: '/auth_gateway.v1.AuthGatewayService/StartFlow',
  ADVANCE_FLOW: '/auth_gateway.v1.AuthGatewayService/AdvanceFlow',
  CREATE_USER: '/identity.v1.IdentityService/CreateUser',
  GET_USER: '/identity.v1.IdentityService/GetUser',
  GET_PERMISSIONS: '/access_control.v1.AccessControlService/GetPermissions',
  CHECK_PERMISSION: '/access_control.v1.AccessControlService/CheckPermission',
  ROTATE_TOKENS: '/session_token.v1.SessionTokenService/RotateTokens',
  REVOKE_SESSION: '/session_token.v1.SessionTokenService/RevokeSession',
  REVOKE_ALL_SESSIONS: '/session_token.v1.SessionTokenService/RevokeAllSessions',
  VALIDATE_ACCESS_TOKEN: '/session_token.v1.SessionTokenService/ValidateAccessToken',
  SET_PASSWORD: '/credential_vault.v1.CredentialVaultService/SetPassword',
} as const;

/** Declared inline on `SessionTokenGrpcClient` rather than exported by the contracts lib. */
interface ValidateAccessTokenRequest {
  accessToken: string;
}

/**
 * Also declared inline there, for the same reason.
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

  async validateAccessToken(
    accessToken: string,
  ): Promise<{
    valid: boolean;
    userId: string;
    email: string;
    roles: readonly string[];
    permissions: readonly string[];
    sessionId: string;
    revocationReason: string;
  }> {
    const request: ValidateAccessTokenRequest = { accessToken };
    const response = await this.peers.call<ValidateAccessTokenResponse>(
      METHOD.VALIDATE_ACCESS_TOKEN,
      request,
    );

    return {
      valid: response.valid,
      userId: response.userId,
      email: response.email,
      roles: response.roles,
      permissions: response.permissions,
      sessionId: response.sessionId,
      revocationReason: response.revocationReason,
    };
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
