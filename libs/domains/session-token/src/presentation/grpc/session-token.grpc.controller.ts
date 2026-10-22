import { Controller } from '@nestjs/common';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  IssueTokensRequest,
  IssueTokensResponse,
  RotateTokensRequest,
  RotateTokensResponse,
  ValidateAccessTokenResponse,
} from '@auth/contracts';
// Value import on purpose — see the note in `session.controller.ts`.
import { SessionTokenService } from '../../application/facade/session-token.service';

const SERVICE = 'SessionTokenService';

/**
 * gRPC transport for session-token, implementing `SessionTokenGrpcClient` server-side.
 *
 * @remarks Every other service depends on this surface instead of reading the database, which
 * is what keeps the refresh-token digests private to the process that minted them.
 *
 * @remarks It extends {@link GrpcControllerBase} because `mergeMicroservice` requires a
 * controller with no HTTP routes; deriving from it keeps that invariant from being forgotten
 * when a method is added.
 */
@Controller()
export class SessionTokenGrpcController extends GrpcControllerBase {
  constructor(private readonly sessionToken: SessionTokenService) {
    super();
  }

  @GrpcMethod(SERVICE, 'IssueTokens')
  async issueTokens(request: IssueTokensRequest): Promise<IssueTokensResponse> {
    const pair = await this.sessionToken.issueTokens({
      userId: request.userId,
      email: request.email,
      roles: request.roles,
      permissions: request.permissions,
      deviceId: request.deviceId,
      ipAddress: request.ipAddress,
    });

    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      sessionId: pair.sessionId,
    };
  }

  @GrpcMethod(SERVICE, 'RotateTokens')
  async rotateTokens(request: RotateTokensRequest): Promise<RotateTokensResponse> {
    const pair = await this.sessionToken.rotateTokens({
      refreshToken: request.refreshToken,
      ipAddress: request.ipAddress,
      deviceId: request.deviceId,
    });

    // `reuse_detected` is never `true` on a successful response: a replay is answered with
    // `TOKEN_REUSE_DETECTED`, after every session in the family has already been revoked.
    // The flag exists for callers that treat the error as non-fatal.
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      sessionId: pair.sessionId,
      reuseDetected: false,
    };
  }

  @GrpcMethod(SERVICE, 'RevokeSession')
  async revokeSession(request: {
    sessionId: string;
    reason: string;
  }): Promise<{ ok: boolean }> {
    await this.sessionToken.revokeSession(request.sessionId, request.reason);
    return { ok: true };
  }

  @GrpcMethod(SERVICE, 'RevokeAllSessions')
  async revokeAllSessions(request: {
    userId: string;
    reason: string;
    exceptSessionId?: string;
  }): Promise<{ revokedCount: number }> {
    const result = await this.sessionToken.revokeAllSessions({
      userId: request.userId,
      reason: request.reason,
      exceptSessionId: request.exceptSessionId,
    });
    return { revokedCount: result.revokedCount };
  }

  @GrpcMethod(SERVICE, 'ValidateAccessToken')
  async validateAccessToken(request: {
    accessToken: string;
  }): Promise<ValidateAccessTokenResponse> {
    // Resolved as an answer rather than an error: a gateway validating a token from a stale
    // browser tab is the ordinary case, not an exceptional one.
    const validation = await this.sessionToken.validateAccessToken(request.accessToken);

    return {
      valid: validation.valid,
      userId: validation.userId,
      email: validation.email,
      roles: validation.roles,
      permissions: validation.permissions,
      sessionId: validation.sessionId,
      revocationReason: validation.revocationReason,
    };
  }
}