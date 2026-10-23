/**
 * @fileoverview Typed client and server contracts for the gRPC surface.
 *
 * Why hand-written instead of generated: the generated interfaces would come from
 * `@grpc/proto-loader` codegen, which the workspace does not run. These mirror the `.proto`
 * files in `libs/contracts/proto` one-to-one — if you change a proto, change the interface
 * in the same commit or the compiler will not catch the drift for you.
 */

// ---- identity.v1 --------------------------------------------------------------

export interface GetUserRequest {
  userId: string;
}
export interface GetUserByEmailRequest {
  email: string;
}
export interface CreateUserRequest {
  email: string;
  displayName: string;
  locale: string;
  source: string;
}
export interface CreateUserResponse {
  user?: UserResponse;
}
export interface AuthenticateRequest {
  accessToken?: string;
  sessionId?: string;
  apiKey?: string;
}
export interface AuthenticateResponse {
  authenticated: boolean;
  user?: UserResponse;
  strategy: string;
  sessionId: string;
}
export interface UserResponse {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerified: boolean;
  roles: string[];
  deleted: boolean;
  createdAt: string;
}
export interface UpdateUserStatusRequest {
  userId: string;
  status: string;
  reason: string;
}

export interface IdentityGrpcClient {
  GetUser(request: GetUserRequest): Promise<UserResponse>;
  GetUserByEmail(request: GetUserByEmailRequest): Promise<UserResponse>;
  CreateUser(request: CreateUserRequest): Promise<CreateUserResponse>;
  Authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse>;
  UpdateUserStatus(request: UpdateUserStatusRequest): Promise<UserResponse>;
}

// ---- access_control.v1 --------------------------------------------------------

export interface GetPermissionsRequest {
  userId: string;
}
export interface GetPermissionsResponse {
  roles: string[];
  permissions: string[];
}
export interface CheckPermissionRequest {
  userId: string;
  permission: string;
  context?: Record<string, string>;
}
export interface CheckPermissionResponse {
  allowed: boolean;
  reason: string;
}
export interface GrantRoleRequest {
  userId: string;
  role: string;
  grantedBy?: string;
}
export interface GrantRoleResponse {
  roles: string[];
}
export interface RevokeRoleRequest {
  userId: string;
  role: string;
}
export interface EvaluatePolicyRequest {
  userId: string;
  policy: string;
  resource?: Record<string, string>;
  context?: Record<string, string>;
}
export interface EvaluatePolicyResponse {
  allowed: boolean;
  reason: string;
}

export interface AccessControlGrpcClient {
  GetPermissions(request: GetPermissionsRequest): Promise<GetPermissionsResponse>;
  CheckPermission(request: CheckPermissionRequest): Promise<CheckPermissionResponse>;
  GrantRole(request: GrantRoleRequest): Promise<GrantRoleResponse>;
  RevokeRole(request: RevokeRoleRequest): Promise<GrantRoleResponse>;
  EvaluatePolicy(request: EvaluatePolicyRequest): Promise<EvaluatePolicyResponse>;
}

// ---- credential_vault.v1 ------------------------------------------------------

export interface VerifyPasswordRequest {
  userId: string;
  password: string;
  allowRehash?: boolean;
}
export interface VerifyPasswordResponse {
  valid: boolean;
  needsRehash: boolean;
  failedAttempts: number;
}
export interface SetPasswordRequest {
  userId: string;
  newPassword: string;
}
export interface SetPasswordResponse {
  ok: boolean;
  credentialId: string;
}

export interface CredentialVaultGrpcClient {
  VerifyPassword(request: VerifyPasswordRequest): Promise<VerifyPasswordResponse>;
  SetPassword(request: SetPasswordRequest): Promise<SetPasswordResponse>;
  RevokeAllCredentials(request: { userId: string; reason: string }): Promise<{ revokedCount: number }>;
}

// ---- session_token.v1 ---------------------------------------------------------

export interface IssueTokensRequest {
  userId: string;
  email: string;
  roles?: string[];
  permissions?: string[];
  deviceId?: string;
  ipAddress?: string;
}
export interface IssueTokensResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}
export interface RotateTokensRequest {
  refreshToken: string;
  ipAddress?: string;
  deviceId?: string;
}
export interface RotateTokensResponse extends IssueTokensResponse {
  reuseDetected: boolean;
}
export interface ValidateAccessTokenResponse {
  valid: boolean;
  userId: string;
  email: string;
  roles: string[];
  permissions: string[];
  sessionId: string;
  revocationReason: string;
}

export interface SessionTokenGrpcClient {
  IssueTokens(request: IssueTokensRequest): Promise<IssueTokensResponse>;
  RotateTokens(request: RotateTokensRequest): Promise<RotateTokensResponse>;
  RevokeSession(request: { sessionId: string; reason: string }): Promise<{ ok: boolean }>;
  RevokeAllSessions(
    request: { userId: string; reason: string; exceptSessionId?: string },
  ): Promise<{ revokedCount: number }>;
  ValidateAccessToken(
    request: { accessToken: string },
  ): Promise<ValidateAccessTokenResponse>;
}

// ---- auth_gateway.v1 ----------------------------------------------------------

export interface StartFlowRequest {
  flow: string;
  email: string;
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
  metadata?: Record<string, string>;
}
export interface AdvanceFlowRequest {
  flowId: string;
  credential: string;
  ipAddress?: string;
  deviceFingerprint?: string;
}
export interface FlowResponse {
  flowId: string;
  state: string;
  flow: string;
  accessToken?: string;
  refreshToken?: string;
  sessionId?: string;
  expiresIn?: number;
  message?: string;
  retryable?: boolean;
  locked?: boolean;
  retryAfterSeconds?: number;
}

export interface AuthGatewayGrpcClient {
  StartFlow(request: StartFlowRequest): Promise<FlowResponse>;
  AdvanceFlow(request: AdvanceFlowRequest): Promise<FlowResponse>;
  GetFlow(request: { flowId: string }): Promise<FlowResponse>;
  CancelFlow(request: { flowId: string; reason: string }): Promise<FlowResponse>;
}

// ---- account_security.v1 ------------------------------------------------------

export interface RecordLoginAttemptRequest {
  userId?: string;
  email?: string;
  succeeded: boolean;
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
}
export interface RecordLoginAttemptResponse {
  locked: boolean;
  failedAttempts: number;
  lockedUntil: number;
  securityEventId: string;
  retryAfterSeconds: number;
}
export interface RiskAssessmentResponse {
  score: number;
  level: string;
  factors: string[];
  recommendations: string[];
}

export interface AccountSecurityGrpcClient {
  RecordLoginAttempt(request: RecordLoginAttemptRequest): Promise<RecordLoginAttemptResponse>;
  AssessLoginRisk(request: Omit<RecordLoginAttemptRequest, 'succeeded'>): Promise<RiskAssessmentResponse>;
  ListDevices(request: { userId: string }): Promise<{ devices: Record<string, unknown>[] }>;
  RevokeDevice(request: { userId: string; deviceId: string }): Promise<{ ok: boolean }>;
}