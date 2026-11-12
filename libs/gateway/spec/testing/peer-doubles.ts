/**
 * @fileoverview In-memory doubles for every port the gateway depends on.
 *
 * @remarks Hand-written rather than generated, for the reason credential-vault's are: a mock
 * asserts the calls a test *expects*, which is the opposite of what "does an unreachable peer
 * become a 503?" needs. These hold state and record what happened, so a test can ask about the
 * sequence rather than about a call count.
 *
 * @remarks The doubles are deliberately *observable* about credentials. `FakeSessionClient`
 * keeps every token it has seen and `FakeCredentialVaultClient` every password it was asked
 * to store, because "the password never reaches a log line" is only a testable claim if
 * something is in a position to catch it.
 *
 * @remarks No fake reads `process.env`, opens a socket or needs a database, which is what lets
 * this whole suite run without Nest and without a container.
 */
import type {
  AccessControlClientPort,
  AuthFlowClientPort,
  CredentialVaultClientPort,
  FlowProgress,
  GatewayUser,
  GatewayUserInput,
  IdentityClientPort,
  SessionClientPort,
} from '../../src/application/ports/peer-clients.port';
import { FlowState } from '../../src/application/ports/peer-clients.port';
import type { GatewayPrincipal } from '../../src/application/ports/gateway-principal';
import type { GatewayConfig, OAuthConfig } from '../../src/gateway.config';
import type { OAuthHttpPort } from '../../src/application/oauth/oauth.port';
import { OAuthService } from '../../src/application/oauth/oauth.service';
import type { GrpcChannel, GrpcStatusCode } from '@auth/infra/grpc';

export const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const OTHER_USER_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
export const EMAIL = 'person@example.com';
export const PASSWORD = 'Str0ng-Passw0rd!x';
export const ACCESS_TOKEN = 'access.token.value';
export const REFRESH_TOKEN = 'refresh.token.value';
export const SESSION_ID = 'session-1';

/** An OAuth walk with every provider off — the unconfigured deployment. */
export const closedOAuth: OAuthConfig = {
  publicOrigin: '',
  stateSecret: '',
  google: null,
  github: null,
  telegram: null,
};

/** An OAuth walk with every provider configured, for the suites that exercise the walk. */
export const openOAuth: OAuthConfig = {
  publicOrigin: 'http://front.test:37000',
  stateSecret: 'state-secret-for-tests',
  google: { clientId: 'google-client-id', clientSecret: 'google-client-secret' },
  github: { clientId: 'github-client-id', clientSecret: 'github-client-secret' },
  telegram: { botToken: '7000000001:test-telegram-bot-token', botUsername: 'front_test_bot' },
};

/** A config built literally, so no test ever reads `process.env`. */
export const testGatewayConfig = (
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig => ({
  peerDeadlineMs: 500,
  identityUrl: 'identity.test:13001',
  accessControlUrl: 'access-control.test:13002',
  credentialVaultUrl: 'credential-vault.test:13003',
  sessionUrl: 'session.test:13004',
  authFlowUrl: 'auth-flow.test:13005',
  catalogUrl: 'catalog.test:13011',
  cartUrl: 'cart.test:13012',
  inventoryUrl: 'inventory.test:13013',
  billingUrl: 'billing.test:13014',
  orderUrl: 'order.test:13015',
  oauth: closedOAuth,
  grpcServiceToken: 'test-service-token',
  accessTokenSigningKey: 'test-access-token-signing-key',
  clockSkewSec: 0,
  ...overrides,
});

export const principalOf = (
  overrides: Partial<GatewayPrincipal> = {},
): GatewayPrincipal => ({
  userId: USER_ID,
  email: EMAIL,
  sessionId: SESSION_ID,
  roles: ['member'],
  permissions: ['users:read'],
  ...overrides,
});

export const userOf = (overrides: Partial<GatewayUser> = {}): GatewayUser => ({
  id: USER_ID,
  email: EMAIL,
  displayName: 'Person',
  status: 'active',
  emailVerified: false,
  deleted: false,
  createdAt: '2026-01-15T09:00:00.000Z',
  ...overrides,
});

/** A flow that completed, with both tokens populated. */
export const completedFlow = (
  overrides: Partial<FlowProgress> = {},
): FlowProgress => ({
  flowId: 'flow-1',
  state: FlowState.COMPLETED,
  flow: 'login',
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  sessionId: SESSION_ID,
  expiresIn: 900,
  ...overrides,
});

// ---- peers -------------------------------------------------------------------------

export class FakeAuthFlowClient implements AuthFlowClientPort {
  /** What `StartFlow` answers with. Defaults to a login flow awaiting its credential. */
  startResult: FlowProgress = {
    flowId: 'flow-1',
    state: FlowState.AWAITING_CREDENTIAL,
    flow: 'login',
  };

  /** What `AdvanceFlow` answers with. */
  advanceResult: FlowProgress = completedFlow();

  startError: unknown;
  advanceError: unknown;

  readonly started: { email: string; ipAddress?: string; userAgent?: string }[] = [];
  readonly advanced: { flowId: string; credential: string }[] = [];

  async startFlow(input: {
    email: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<FlowProgress> {
    this.started.push(input);
    if (this.startError) throw this.startError;
    return this.startResult;
  }

  async advanceFlow(input: {
    flowId: string;
    credential: string;
    ipAddress?: string;
  }): Promise<FlowProgress> {
    this.advanced.push({ flowId: input.flowId, credential: input.credential });
    if (this.advanceError) throw this.advanceError;
    return this.advanceResult;
  }
}

export class FakeIdentityClient implements IdentityClientPort {
  user: GatewayUser = userOf();
  createError: unknown;
  getError: unknown;
  resolveError: unknown;
  /** What `ResolveOauthUser` answers with. Defaults to "found the account behind the link". */
  resolved: { user: GatewayUser; created: boolean } | null = null;

  readonly created: GatewayUserInput[] = [];
  readonly fetchedById: string[] = [];
  readonly resolvedFor: {
    provider: string;
    subject: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
  }[] = [];

  async createUser(input: GatewayUserInput): Promise<GatewayUser> {
    this.created.push(input);
    if (this.createError) throw this.createError;
    return this.user;
  }

  async getUser(userId: string): Promise<GatewayUser> {
    this.fetchedById.push(userId);
    if (this.getError) throw this.getError;
    return this.user;
  }

  async resolveOauthUser(input: {
    provider: string;
    subject: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
  }): Promise<{ user: GatewayUser; created: boolean }> {
    this.resolvedFor.push(input);
    if (this.resolveError) throw this.resolveError;
    return this.resolved ?? { user: this.user, created: false };
  }
}

export class FakeAccessControlClient implements AccessControlClientPort {
  roles: string[] = ['member'];
  permissions: string[] = ['users:read', 'users:password:set'];
  getError: unknown;

  readonly granted: { userId: string; permission: string }[] = [];

  /** Every user whose full grant set was read. Distinguishes "asked" from "never asked". */
  readonly permissionLookups: string[] = [];

  async getPermissions(userId: string): Promise<{
    roles: string[];
    permissions: string[];
  }> {
    this.permissionLookups.push(userId);
    if (this.getError) throw this.getError;
    return { roles: this.roles, permissions: this.permissions };
  }

  async checkPermission(input: {
    userId: string;
    permission: string;
  }): Promise<{ allowed: boolean; reason: string }> {
    this.granted.push(input);
    return {
      allowed: this.permissions.includes(input.permission),
      reason: this.permissions.includes(input.permission)
        ? 'granted by role'
        : 'no role grants this permission',
    };
  }
}

export class FakeSessionClient implements SessionClientPort {
  rotateResult = {
    accessToken: 'access.rotated',
    refreshToken: 'refresh.rotated',
    expiresIn: 900,
    sessionId: 'session-2',
    reuseDetected: false,
  };

  revokedCount = 2;
  rotateError: unknown;
  revokeError: unknown;
  issueError: unknown;
  /** What `IssueTokens` answers with — the pair a fresh registration or OAuth walk lands on. */
  issueResult = {
    accessToken: 'access.issued',
    refreshToken: 'refresh.issued',
    expiresIn: 900,
    sessionId: 'session-issued',
  };
  readonly revokedOne: { sessionId: string; reason: string }[] = [];

  readonly rotated: string[] = [];
  readonly issued: { userId: string; email: string; ipAddress?: string }[] = [];
  readonly revoked: {
    userId: string;
    reason: string;
    exceptSessionId?: string;
  }[] = [];

  async issueTokens(input: {
    userId: string;
    email: string;
    ipAddress?: string;
  }) {
    this.issued.push(input);
    if (this.issueError) throw this.issueError;
    return this.issueResult;
  }

  async rotateTokens(input: { refreshToken: string; ipAddress?: string }) {
    this.rotated.push(input.refreshToken);
    if (this.rotateError) throw this.rotateError;
    return this.rotateResult;
  }

  async revokeSession(input: { sessionId: string; reason: string }): Promise<boolean> {
    this.revokedOne.push(input);
    if (this.revokeError) throw this.revokeError;
    return true;
  }

  async revokeAllSessions(input: {
    userId: string;
    reason: string;
    exceptSessionId?: string;
  }): Promise<number> {
    this.revoked.push(input);
    if (this.revokeError) throw this.revokeError;
    return this.revokedCount;
  }
}

export class FakeCredentialVaultClient implements CredentialVaultClientPort {
  credentialId = 'cred-1';
  error: unknown;
  revokeError: unknown;
  revokeResult = 1;

  /**
   * Every plaintext this port was asked to hold.
   *
   * @remarks Stored rather than hashed, deliberately: a fake that cannot show the value cannot
   * demonstrate that the value stayed in one place. Nothing in the suite reads this except the
   * test asserting the password is confined to this call.
   */
  readonly stored: { userId: string; newPassword: string }[] = [];
  /** Every compensation this port was asked to perform, and under what reason. */
  readonly revoked: { userId: string; reason?: string }[] = [];

  async setPassword(input: {
    userId: string;
    newPassword: string;
  }): Promise<{ credentialId: string }> {
    this.stored.push(input);
    if (this.error) throw this.error;
    return { credentialId: this.credentialId };
  }

  async revokeAll(input: { userId: string; reason?: string }): Promise<number> {
    this.revoked.push(input);
    if (this.revokeError) throw this.revokeError;
    return this.revokeResult;
  }
}

/**
 * The provider walk's HTTP room, with a scriptable answer per room.
 *
 * @remarks Answers are keyed by URL *prefix*, so a test reads as "the token endpoint said
 * this" — the same reason `ScriptedChannel` keys by method name.
 */
export class FakeOAuthHttp implements OAuthHttpPort {
  postError: unknown;
  getError: unknown;

  private readonly postAnswers = new Map<string, unknown>();
  private readonly getAnswers = new Map<string, unknown>();

  readonly posts: { url: string; form: Readonly<Record<string, string>> }[] = [];
  readonly gets: { url: string; bearer?: string }[] = [];

  answerPost(urlPrefix: string, answer: unknown): this {
    this.postAnswers.set(urlPrefix, answer);
    return this;
  }

  answerGet(urlPrefix: string, answer: unknown): this {
    this.getAnswers.set(urlPrefix, answer);
    return this;
  }

  async postForm(
    url: string,
    form: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    this.posts.push({ url, form });
    if (this.postError) throw this.postError;
    return this.lookup(this.postAnswers, url);
  }

  async getJson(url: string, bearer?: string): Promise<unknown> {
    this.gets.push({ url, bearer });
    if (this.getError) throw this.getError;
    return this.lookup(this.getAnswers, url);
  }

  /**
   * The most specific prefix wins, so `.../user` and `.../user/emails` can both be
   * scripted without the shorter one swallowing the longer URL.
   */
  private lookup(table: Map<string, unknown>, url: string): unknown {
    let best: { prefix: string; answer: unknown } | null = null;
    for (const [prefix, answer] of table) {
      if (url.startsWith(prefix) && (best === null || prefix.length > best.prefix.length)) {
        best = { prefix, answer };
      }
    }
    return best === null ? null : best.answer;
  }
}

/**
 * An `OAuthService` over doubles, for suites whose subject is some *other* handler on the
 * controller that merely shares its constructor.
 *
 * @remarks The default configuration is the unconfigured deployment — providers off, no
 * state secret — so a suite that never calls into the walk cannot accidentally depend on a
 * configured one being present.
 */
export const fakeOAuthService = (
  config: GatewayConfig = testGatewayConfig(),
  http: OAuthHttpPort = new FakeOAuthHttp(),
  identity: IdentityClientPort = new FakeIdentityClient(),
  sessions: SessionClientPort = new FakeSessionClient(),
): OAuthService => new OAuthService(config, http, identity, sessions);

// ---- transport ---------------------------------------------------------------------

/** A gRPC failure, shaped the way `@grpc/grpc-js` shapes one. */
export const grpcError = (
  code: GrpcStatusCode,
  message = 'upstream detail nobody outside may read',
): Error & { code: number } =>
  Object.assign(new Error(message), { code: numericStatusOf(code) });

/** The protocol's numeric codes, in order, so a test can state `14` or the name. */
const STATUS_NUMBERS: Readonly<Record<GrpcStatusCode, number>> = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};

export const numericStatusOf = (code: GrpcStatusCode): number =>
  STATUS_NUMBERS[code] ?? 2;

/**
 * A channel with a scripted answer per method.
 *
 * @remarks Used to exercise the adapters and the peer-caller's error translation, which are
 * the two places a gRPC failure has to stop being a gRPC failure. Registering by method name
 * means a test reads as "auth-flow is unavailable", which is the claim being made.
 */
export class ScriptedChannel implements GrpcChannel {
  readonly calls: { method: string; request: unknown; deadline: number }[] = [];

  private readonly answers = new Map<string, unknown>();

  on(method: string, answer: unknown): this {
    this.answers.set(method, answer);
    return this;
  }

  async unary<TRequest extends object, TResponse>(
    method: string,
    request: TRequest,
    options: { deadline: number },
  ): Promise<TResponse> {
    this.calls.push({ method, request, deadline: options.deadline });
    const answer = this.answers.get(method);
    if (answer instanceof Error) throw answer;
    return answer as TResponse;
  }

  getState() {
    return 'READY' as const;
  }

  async close(): Promise<void> {
    /* nothing to release: there is no socket */
  }
}
