/**
 * @fileoverview In-memory doubles for every port, plus the fixed clock the suite runs on.
 *
 * @remarks Hand-written rather than auto-mocked, for the same reason mfa's fakes are: a mock
 * asserts on the calls a test *expects*, which is the opposite of what "does the second
 * attempt fail" needs. Here the question is always about state, so the doubles hold state.
 *
 * @remarks The repository stores **rehydrated copies**, not the aggregates it was handed. That
 * is deliberate and load-bearing: an assertion about `flow.steps` after a save proves the
 * audit trail reached storage, rather than proving it is still sitting in an object the handler
 * happens to be holding. It also exercises `fromRow` on every read.
 */

import type { IDomainEvent } from '@auth/ddd-core';
import { AuthFlow, type AuthFlowRow } from '../../src/domain/auth-flow.aggregate';
import type { AuthGatewayConfig } from '../../src/auth-gateway.config';
import type { AuthFlowRepositoryPort } from '../../src/domain/ports/auth-flow-repository.port';
import type {
  AccountLockState,
  AccountSecurityPort,
  LoginAttemptRecord,
} from '../../src/domain/ports/account-security.port';
import type { CredentialPort } from '../../src/domain/ports/credential.port';
import type { IdentityPort, IdentityUserView } from '../../src/domain/ports/identity.port';
import type { MfaPort } from '../../src/domain/ports/mfa.port';
import type {
  IssuedTokens,
  SessionPort,
} from '../../src/domain/ports/session.port';
import { OPEN_STATES } from '../../src/domain/value-objects/auth-flow-state.vo';

export const T0 = new Date('2026-01-15T09:00:00.000Z');
export const T1 = new Date(T0.getTime() + 1_000);
export const T2 = new Date(T0.getTime() + 2_000);

export const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const OTHER_USER_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
export const EMAIL = 'person@example.com';

/** Five minutes — long enough to fetch an authenticator, short enough to be worth expiring. */
export const FLOW_TTL_MS = 300_000;

export const testConfig = (
  overrides: Partial<AuthGatewayConfig> = {},
): AuthGatewayConfig => ({
  flowTtlMs: FLOW_TTL_MS,
  maxAttempts: 5,
  grpcDeadlineMs: 3_000,
  identityUrl: 'identity:5001',
  credentialVaultUrl: 'vault:5002',
  mfaUrl: 'mfa:5003',
  sessionTokenUrl: 'session:5004',
  ...overrides,
});

/** Flattens an aggregate into the row shape persistence would hand back. */
export const flowRowOf = (flow: AuthFlow): AuthFlowRow => ({
  id: flow.id.value,
  strategy: flow.flow,
  status: flow.state,
  user_id: flow.userId,
  device_id: flow.deviceId,
  client_ip: flow.clientIp,
  user_agent: flow.userAgent,
  attempt_count: flow.attemptCount,
  max_attempts: flow.maxAttempts,
  started_at: flow.startedAt,
  updated_at: flow.updatedAt,
  expires_at: flow.expiresAt,
  completed_at: flow.completedAt,
  failure_reason: flow.failureReason,
  abort_reason: flow.abortReason,
  version: flow.version,
  auth_flow_steps: flow.steps.map((step, index) => ({
    id: BigInt(index + 1),
    flow_id: flow.id.value,
    from_status: step.from,
    to_status: step.to,
    occurred_at: step.occurredAt,
  })),
});

/** A login-shaped flow, opened but untouched. */
export function openFlow(overrides: Partial<Parameters<typeof AuthFlow.start>[0]> = {}): AuthFlow {
  return AuthFlow.start({
    flow: 'login',
    userId: USER_ID,
    ttlMs: FLOW_TTL_MS,
    now: T0,
    ...overrides,
  });
}

export class InMemoryAuthFlowRepository implements AuthFlowRepositoryPort {
  /** Stored rows, rehydrated — what a later request would actually load. */
  readonly rows = new Map<string, AuthFlowRow>();

  /** Every event that reached storage, in the order it was committed. */
  readonly published: IDomainEvent[] = [];

  /** How many times a write happened — the transaction boundary a test can count. */
  saves = 0;

  async save(flow: AuthFlow): Promise<void> {
    this.published.push(...flow.clearDomainEvents());
    this.rows.set(flow.id.value, flowRowOf(flow));
    this.saves += 1;
  }

  async findById(id: string): Promise<AuthFlow | null> {
    const row = this.rows.get(id);
    return row ? AuthFlow.fromRow(row) : null;
  }

  async countActive(now: Date): Promise<number> {
    return [...this.rows.values()].filter(
      (row) => OPEN_STATES.includes(row.status as never) && row.expires_at > now,
    ).length;
  }
}

export class FakeIdentity implements IdentityPort {
  /** Keyed by lower-cased address, which is the case-insensitivity the port promises. */
  readonly users = new Map<string, IdentityUserView>();

  byEmailCalls: string[] = [];
  byIdCalls: string[] = [];

  addUser(user: Partial<IdentityUserView> & { id: string; email: string }): void {
    this.users.set(user.email.toLowerCase(), {
      id: user.id,
      email: user.email,
      status: user.status ?? 'active',
      emailVerified: user.emailVerified ?? true,
    });
  }

  async findUserByEmail(email: string): Promise<IdentityUserView | null> {
    this.byEmailCalls.push(email);
    return this.users.get(email.trim().toLowerCase()) ?? null;
  }

  async findUserById(userId: string): Promise<IdentityUserView | null> {
    this.byIdCalls.push(userId);
    return [...this.users.values()].find((user) => user.id === userId) ?? null;
  }
}

export class FakeCredentials implements CredentialPort {
  /** The one password that verifies. `null` means every attempt fails. */
  password: string | null = 'correct horse';

  calls: { userId: string; password: string }[] = [];

  async verifyPassword(input: {
    userId: string;
    password: string;
  }): Promise<{ valid: boolean; failedAttempts: number }> {
    this.calls.push({ userId: input.userId, password: input.password });
    return {
      valid: this.password !== null && input.password === this.password,
      failedAttempts: 0,
    };
  }
}

export class FakeMfa implements MfaPort {
  enabled = false;
  acceptedCode = '123456';

  isEnabledCalls: string[] = [];
  verifyCalls: { userId: string; code: string }[] = [];

  async isEnabled(input: { userId: string }): Promise<boolean> {
    this.isEnabledCalls.push(input.userId);
    return this.enabled;
  }

  async verifyFactor(input: { userId: string; code: string }): Promise<{ verified: boolean }> {
    this.verifyCalls.push({ userId: input.userId, code: input.code });
    return { verified: input.code === this.acceptedCode };
  }
}

export class FakeSessions implements SessionPort {
  readonly issued: { userId: string; email: string }[] = [];
  readonly rotated: string[] = [];

  async issueTokens(input: {
    userId: string;
    email: string;
  }): Promise<IssuedTokens> {
    this.issued.push({ userId: input.userId, email: input.email });
    return {
      accessToken: `access.${this.issued.length}`,
      refreshToken: `refresh.${this.issued.length}`,
      sessionId: `session-${this.issued.length}`,
      expiresIn: 900,
    };
  }

  async rotateTokens(input: { refreshToken: string }): Promise<
    IssuedTokens & { reuseDetected: boolean }
  > {
    this.rotated.push(input.refreshToken);
    return {
      accessToken: 'access.rotated',
      refreshToken: 'refresh.rotated',
      sessionId: 'session-rotated',
      expiresIn: 900,
      reuseDetected: false,
    };
  }
}

/**
 * account-security as the flow sees it: a lock decision, plus whatever the service cannot see.
 *
 * @remarks It holds state rather than a canned reply because the interesting question is never
 * "was it called" but "given these counters, what is the caller told". The unreachable mode is a
 * first-class state, not a thrown mock: an unreachable peer is a real runtime condition the
 * handler promises to survive, and a test that only ever sees a successful reply proves nothing
 * about that promise.
 */
export class FakeAccountSecurity implements AccountSecurityPort {
  readonly attempts: LoginAttemptRecord[] = [];

  /** Set by a test to simulate the counters running out. */
  lock: AccountLockState = { locked: false, lockedUntil: null, retryAfterSeconds: 0 };

  /** Set to a message to make the service unreachable. */
  unreachableReason: string | null = null;

  async recordAttempt(record: LoginAttemptRecord): Promise<AccountLockState> {
    this.attempts.push(record);
    if (this.unreachableReason !== null) {
      throw new Error(this.unreachableReason);
    }
    return this.lock;
  }
}