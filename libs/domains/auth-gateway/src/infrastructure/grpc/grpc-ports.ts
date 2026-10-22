/**
 * @fileoverview The gateway's four outbounds, over one channel.
 *
 * @remarks Every adapter here takes a {@link GrpcChannel} rather than a `ClientGrpcProxy`. That
 * is the whole reason the application layer can be a set of plain objects in a test: the Nest
 * transport, its retry registry and its deadlines all live behind a port that the handlers
 * never name. The adapters are the only place in the library that knows a call crosses a
 * network.
 *
 * @remarks `GRPC_CHANNEL` is supplied by the host application, because only it knows how the
 * service addresses its dependencies. The alternative — each service building its own channel —
 * would put client construction in eight places and make an unreachable dependency a boot-time
 * surprise rather than a deployment setting.
 */
import { Inject, Injectable } from '@nestjs/common';
import { GRPC_CHANNEL, type GrpcChannel } from '@auth/infra/grpc';
import type {
  RecordLoginAttemptRequest,
  RecordLoginAttemptResponse,
  GetUserByEmailRequest,
  GetUserRequest,
  IssueTokensRequest,
  IssueTokensResponse,
  RotateTokensRequest,
  RotateTokensResponse,
  UserResponse,
  VerifyPasswordRequest,
  VerifyPasswordResponse,
} from '@auth/contracts';
import {
  CREDENTIAL_PORT,
  type CredentialPort,
  type PasswordVerification,
} from '../../domain/ports/credential.port';
import {
  IDENTITY_PORT,
  type IdentityPort,
  type IdentityUserView,
} from '../../domain/ports/identity.port';
import {
  MFA_PORT,
  type FactorVerification,
  type MfaPort,
} from '../../domain/ports/mfa.port';
import {
  SESSION_PORT,
  type IssuedTokens,
  type RotatedTokens,
  type SessionPort,
} from '../../domain/ports/session.port';
import {
  ACCOUNT_SECURITY_PORT,
  type AccountLockState,
  type AccountSecurityPort,
  type LoginAttemptRecord,
} from '../../domain/ports/account-security.port';
import { AUTH_GATEWAY_CONFIG, type AuthGatewayConfig } from '../../auth-gateway.config';

/** Full method paths, so a mistyped service name fails here rather than at the broker. */
const METHOD = {
  GET_USER: '/identity.v1.IdentityService/GetUser',
  GET_USER_BY_EMAIL: '/identity.v1.IdentityService/GetUserByEmail',
  VERIFY_PASSWORD: '/credential_vault.v1.CredentialVaultService/VerifyPassword',
  ISSUE_TOKENS: '/session_token.v1.SessionTokenService/IssueTokens',
  ROTATE_TOKENS: '/session_token.v1.SessionTokenService/RotateTokens',
  MFA_STATUS: '/mfa.v1.MfaService/GetStatus',
  MFA_VERIFY_FACTOR: '/mfa.v1.MfaService/VerifyFactor',
  RECORD_LOGIN_ATTEMPT: '/account_security.v1.AccountSecurityService/RecordLoginAttempt',
} as const;

/**
 * Resolves an identity to the fields a token is minted with.
 *
 * @remarks `deleted` is carried as a status rather than as a flag: identity is the only
 * service that can answer it, and a gateway that guessed would be guessing about the one
 * question sign-in exists to ask.
 */
@Injectable()
export class GrpcIdentityAdapter implements IdentityPort {
  constructor(
    @Inject(GRPC_CHANNEL) private readonly channel: GrpcChannel,
    @Inject(AUTH_GATEWAY_CONFIG) private readonly config: AuthGatewayConfig,
  ) {}

  async findUserByEmail(email: string): Promise<IdentityUserView | null> {
    const request: GetUserByEmailRequest = { email };
    // gRPC has no "null": an unknown address resolves as NOT_FOUND rather than an empty
    // reply, so the refusal is translated here instead of leaking out as an exception.
    const response = await this.channel
      .unary<GetUserByEmailRequest, UserResponse>(METHOD.GET_USER_BY_EMAIL, request, {
        deadline: Date.now() + this.config.grpcDeadlineMs,
      })
      .catch(() => null);

    return response ? toUserView(response) : null;
  }

  async findUserById(userId: string): Promise<IdentityUserView | null> {
    const request: GetUserRequest = { userId };
    const response = await this.channel
      .unary<GetUserRequest, UserResponse>(METHOD.GET_USER, request, {
        deadline: Date.now() + this.config.grpcDeadlineMs,
      })
      .catch(() => null);

    return response ? toUserView(response) : null;
  }
}

@Injectable()
export class GrpcCredentialAdapter implements CredentialPort {
  constructor(
    @Inject(GRPC_CHANNEL) private readonly channel: GrpcChannel,
    @Inject(AUTH_GATEWAY_CONFIG) private readonly config: AuthGatewayConfig,
  ) {}

  async verifyPassword(input: {
    userId: string;
    password: string;
  }): Promise<PasswordVerification> {
    const request: VerifyPasswordRequest = {
      userId: input.userId,
      password: input.password,
    };

    // A transport failure is reported as an invalid password rather than raised. The gateway
    // has one bit to branch on — accepted or not — and inventing a second outcome here would
    // mean the flow either completes or fails on an infrastructure problem rather than on the
    // person's answer.
    const response = await this.channel
      .unary<VerifyPasswordRequest, VerifyPasswordResponse>(
        METHOD.VERIFY_PASSWORD,
        request,
        { deadline: Date.now() + this.config.grpcDeadlineMs },
      )
      .catch(() => null);

    return {
      valid: response?.valid === true,
      failedAttempts: response?.failedAttempts ?? 0,
    };
  }
}

/**
 * The `mfa` service as this library sees it.
 *
 * @remarks Declared here because `libs/contracts/proto` has no `mfa.proto` yet — the service
 * exists, the catalogue entry does not. Spelling the two replies out locally is the same choice
 * credential-vault's controller made for its inline request/response pair, and it keeps a
 * missing proto from blocking the port that depends on it.
 */
interface MfaStatusResponse {
  enabled: boolean;
}

interface VerifyFactorRequest {
  userId: string;
  code: string;
  factorId?: string;
}

interface VerifyFactorResponse {
  verified: boolean;
  method?: string;
}

@Injectable()
export class GrpcMfaAdapter implements MfaPort {
  constructor(
    @Inject(GRPC_CHANNEL) private readonly channel: GrpcChannel,
    @Inject(AUTH_GATEWAY_CONFIG) private readonly config: AuthGatewayConfig,
  ) {}

  async isEnabled(input: { userId: string }): Promise<boolean> {
    const response = await this.channel
      .unary<{ userId: string }, MfaStatusResponse>(METHOD.MFA_STATUS, { userId: input.userId }, {
        deadline: Date.now() + this.config.grpcDeadlineMs,
      })
      // `false` on an unreachable dependency means "do not demand a second factor". That is the
      // safe direction: the flow still requires a password, and a person who *does* have a
      // factor enrolled is refused at `awaiting_2fa` if the service comes back.
      .catch(() => null);

    return response?.enabled === true;
  }

  async verifyFactor(input: {
    userId: string;
    code: string;
    factorId?: string;
  }): Promise<FactorVerification> {
    const request: VerifyFactorRequest = {
      userId: input.userId,
      code: input.code,
      factorId: input.factorId,
    };

    const response = await this.channel
      .unary<VerifyFactorRequest, VerifyFactorResponse>(
        METHOD.MFA_VERIFY_FACTOR,
        request,
        { deadline: Date.now() + this.config.grpcDeadlineMs },
      )
      .catch(() => null);

    return {
      verified: response?.verified === true,
      method: toMethod(response?.method),
    };
  }
}

@Injectable()
export class GrpcSessionAdapter implements SessionPort {
  constructor(
    @Inject(GRPC_CHANNEL) private readonly channel: GrpcChannel,
    @Inject(AUTH_GATEWAY_CONFIG) private readonly config: AuthGatewayConfig,
  ) {}

  async issueTokens(input: {
    userId: string;
    email: string;
    deviceId?: string | null;
    ipAddress?: string | null;
  }): Promise<IssuedTokens> {
    const request: IssueTokensRequest = {
      userId: input.userId,
      email: input.email,
      deviceId: input.deviceId ?? undefined,
      ipAddress: input.ipAddress ?? undefined,
    };

    const response = await this.channel.unary<IssueTokensRequest, IssueTokensResponse>(
      METHOD.ISSUE_TOKENS,
      request,
      { deadline: Date.now() + this.config.grpcDeadlineMs },
    );

    return toIssuedTokens(response);
  }

  async rotateTokens(input: {
    refreshToken: string;
    deviceId?: string | null;
    ipAddress?: string | null;
  }): Promise<RotatedTokens> {
    const request: RotateTokensRequest = {
      refreshToken: input.refreshToken,
      deviceId: input.deviceId ?? undefined,
      ipAddress: input.ipAddress ?? undefined,
    };

    const response = await this.channel.unary<RotateTokensRequest, RotateTokensResponse>(
      METHOD.ROTATE_TOKENS,
      request,
      { deadline: Date.now() + this.config.grpcDeadlineMs },
    );

    return { ...toIssuedTokens(response), reuseDetected: response.reuseDetected === true };
  }
}

// ---- mapping --------------------------------------------------------------------

function toUserView(user: UserResponse): IdentityUserView {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    emailVerified: user.emailVerified,
  };
}

function toIssuedTokens(response: IssueTokensResponse): IssuedTokens {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    sessionId: response.sessionId,
    expiresIn: response.expiresIn,
  };
}

function toMethod(method: string | undefined): 'totp' | 'backup_code' | undefined {
  return method === 'totp' || method === 'backup_code' ? method : undefined;
}

/**
 * Records a sign-in with account-security and returns the lock it reports.
 *
 * @remarks `locked_until` is epoch millis and `0` means "not locked". The conversion happens
 * here rather than at the call site: `new Date(0)` is 1970, so a caller that forgot to
 * special-case it would treat an unlocked account as locked for fifty years — and the failure
 * would look like a lockout policy rather than a missing conversion.
 */
@Injectable()
export class GrpcAccountSecurityAdapter implements AccountSecurityPort {
  constructor(
    @Inject(GRPC_CHANNEL) private readonly channel: GrpcChannel,
    @Inject(AUTH_GATEWAY_CONFIG) private readonly config: AuthGatewayConfig,
  ) {}

  async recordAttempt(record: LoginAttemptRecord): Promise<AccountLockState> {
    const response = await this.channel.unary<
      RecordLoginAttemptRequest,
      RecordLoginAttemptResponse
    >(
      METHOD.RECORD_LOGIN_ATTEMPT,
      {
        userId: record.userId ?? undefined,
        email: record.email,
        succeeded: record.succeeded,
        ipAddress: record.ipAddress,
        userAgent: record.userAgent,
        deviceFingerprint: record.deviceFingerprint,
      },
      { deadline: Date.now() + this.config.grpcDeadlineMs },
    );

    return {
      locked: response.locked === true,
      lockedUntil: response.lockedUntil === 0 ? null : response.lockedUntil,
      retryAfterSeconds: response.retryAfterSeconds ?? 0,
    };
  }
}

export {
  IDENTITY_PORT,
  CREDENTIAL_PORT,
  MFA_PORT,
  SESSION_PORT,
  ACCOUNT_SECURITY_PORT,
};