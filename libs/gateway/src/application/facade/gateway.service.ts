/**
 * @fileoverview Everything the edge can be asked to do.
 *
 * @remarks One class, six methods, no state. That is not brevity for its own sake: the gateway
 * is a proxy, so a field on this object would be a field that goes stale the moment the peer
 * it mirrors changes. There is no cache here on purpose — caching an authorization answer at
 * the edge is how a revoked role keeps working for the length of a TTL, and the only thing
 * this service is allowed to hold between requests is a socket.
 *
 * @remarks Every decision below is somebody else's. "Is this password right?" is
 * credential-vault's. "What may this user do?" is access-control's. "Is this token still
 * valid?" is session's. This class sequences the calls and translates the answers; a
 * rule written here would be a rule that only the edge enforces, which is the exact failure
 * mode a service-per-ownership split exists to prevent.
 *
 * @remarks **No password ever reaches a log, a response or an exception context.** The
 * platform filter redacts known-sensitive keys, but that is the second line of defence; the
 * first is that this class never copies a secret anywhere. `login` takes the password as a
 * parameter, hands it to one peer, and lets it go out of scope.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { actorKindOf, effectiveRoles } from '@auth/contracts';
import {
  AccountLockedException,
  InvalidCredentialsException,
  MfaRequiredException,
  TokenReuseDetectedException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  ACCESS_CONTROL_CLIENT,
  AUTH_FLOW_CLIENT,
  CREDENTIAL_VAULT_CLIENT,
  FlowState,
  FURTHER_PROOF,
  IDENTITY_CLIENT,
  SESSION_CLIENT,
  TERMINAL_FAILURES,
  type AccessControlClientPort,
  type AuthFlowClientPort,
  type CredentialVaultClientPort,
  type FlowProgress,
  type GatewayUser,
  type GatewayUserInput,
  type IdentityClientPort,
  type SessionClientPort,
} from '../ports/peer-clients.port';
import { grantSignupRole } from '../grant-signup-role';
import { USER_SOURCE_WEB } from '../user-source';
import type { GatewayPrincipal } from '../ports/gateway-principal';

export interface LoginInput {
  readonly email: string;
  /** Never stored, never logged, never echoed — see the note at the top of this file. */
  readonly password: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface RegisterInput {
  readonly email: string;
  /** The same confinement rule as {@link LoginInput.password}: one call, then gone. */
  readonly password: string;
  readonly displayName?: string;
  readonly locale?: string;
  readonly ipAddress?: string;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly sessionId: string;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly revokedCount: number;
}

export interface CurrentUser {
  readonly user: GatewayUser;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly actorKind: ReturnType<typeof actorKindOf>;
  readonly sessionId: string;
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    @Inject(AUTH_FLOW_CLIENT) private readonly flows: AuthFlowClientPort,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityClientPort,
    @Inject(ACCESS_CONTROL_CLIENT)
    private readonly accessControl: AccessControlClientPort,
    @Inject(SESSION_CLIENT) private readonly sessions: SessionClientPort,
    @Inject(CREDENTIAL_VAULT_CLIENT)
    private readonly credentials: CredentialVaultClientPort,
  ) {}

  /**
   * Signs someone in by walking auth-flow's login flow.
   *
   * @remarks Two calls, and the edge does not merge them: `StartFlow` establishes who is
   * signing in and on what, `AdvanceFlow` is the only thing that ever sees the password. That
   * ordering is why a rate limiter or a step-up policy can be added to the flow without the
   * gateway changing — it does not know a flow exists beyond the two calls.
   *
   * @remarks The state the flow comes back in is translated, not reinterpreted. `failed`,
   * `expired` and `cancelled` all mean the same thing to a caller holding a password, and
   * telling them apart would be telling them about the internals of someone else's state
   * machine.
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const opened = await this.flows.startFlow({
      email: input.email,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    if (opened.state !== FlowState.AWAITING_CREDENTIAL) {
      // The peer opened a flow in a state this endpoint cannot use. Refusing is right: the
      // alternative is sending a password to a flow that was not expecting one.
      throw new ValidationException('the authentication flow could not be opened', {
        reason: 'the service did not ask for a credential',
      });
    }

    // The password goes here and nowhere else.
    const outcome = await this.flows.advanceFlow({
      flowId: opened.flowId,
      credential: input.password,
      ipAddress: input.ipAddress,
    });

    if (outcome.state === FlowState.COMPLETED) {
      return toLoginResult(outcome);
    }

    // Before the terminal-failure branch: a lock is a *more specific* answer than "the details
    // were not accepted", and the two are the only difference a person waiting out fifteen
    // minutes needs. account-security reports it as flow state because gRPC has no status for
    // it; this layer is where an outcome becomes the status the caller is entitled to.
    if (outcome.locked === true) {
      throw new AccountLockedException('the account is temporarily locked', {
        retryAfterSeconds: outcome.retryAfterSeconds ?? 0,
      });
    }

    if (FURTHER_PROOF.has(outcome.state as never)) {
      // Not a failure: the password was right and the flow wants a second factor. The flow id
      // travels with it so the caller can continue the same walk rather than start a new one.
      throw new MfaRequiredException(outcome.message ?? undefined, {
        flowId: outcome.flowId,
        state: outcome.state,
      });
    }

    if (TERMINAL_FAILURES.has(outcome.state as never)) {
      throw new InvalidCredentialsException();
    }

    // A state nobody here has seen, on a flow that is not complete. No token was issued, and
    // that is the only fact this edge can stand behind.
    throw new InvalidCredentialsException();
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * @remarks A replayed refresh token revokes the whole family inside session before it
   * answers. Surfacing that as its own 401 lets a client clear its storage instead of
   * retrying a token the service has already decided is burned.
   */
  async refresh(input: {
    refreshToken: string;
    ipAddress?: string;
  }): Promise<LoginResult> {
    const rotated = await this.sessions.rotateTokens({
      refreshToken: input.refreshToken,
      ipAddress: input.ipAddress,
    });

    if (rotated.reuseDetected) {
      throw new TokenReuseDetectedException();
    }

    return {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresIn: rotated.expiresIn,
      sessionId: rotated.sessionId,
    };
  }

  /**
   * Signs the caller out everywhere.
   *
   * @remarks Logout ends the session it was called with. Protecting the caller's own session
   * makes sense for "sign out everywhere else", where keeping the active tab alive is the
   * point — but applied to `logout` it revokes nothing at all for the ordinary single-device
   * user, and the access token they just used keeps working. So the default is the current
   * session, and `everywhere` widens it to the rest.
   */
  async logout(
    principal: GatewayPrincipal,
    input: { reason: string; everywhere?: boolean },
  ): Promise<SessionSummary> {
    if (!input.everywhere) {
      await this.sessions.revokeSession({
        sessionId: principal.sessionId,
        reason: input.reason,
      });
      return { sessionId: principal.sessionId, revokedCount: 1 };
    }

    const revokedCount = await this.sessions.revokeAllSessions({
      userId: principal.userId,
      reason: input.reason,
    });

    return { sessionId: principal.sessionId, revokedCount };
  }

  /**
   * The caller's own profile, with their live authorisations attached.
   *
   * @remarks The guard already produced the principal — from a verified bearer or, on
   * guest-allowed routes, from a validated `X-Guest-Id` — and this composes what that answer
   * did not carry. Roles and permissions come from access-control rather than from token
   * claims, because a claim is a snapshot taken at mint time — reading it here would answer
   * "what could this caller do an hour ago", which is the question nobody actually asked.
   *
   * @remarks The subject is `userId` for an account and `sessionId` for a guest: the guest
   * id travels in the one field a session-only principal has, and it *is* that guest row's
   * id in identity. An id identity does not know gets identity's own 404 — the truthful
   * answer for a row that was reaped, not a profile composed from nothing.
   *
   * @remarks The two lookups run concurrently and the response is all-or-nothing. Half a
   * profile — an identity with no permissions — reads as "this user has none", which is a
   * confident and completely wrong answer to hand a client.
   */
  async me(principal: GatewayPrincipal): Promise<CurrentUser> {
    const subjectId = principal.userId === '' ? principal.sessionId : principal.userId;

    const [user, grants] = await Promise.all([
      this.identity.getUser(subjectId),
      this.accessControl.getPermissions(subjectId),
    ]);

    // `guest` is a status, not a grant: identity owns that fact and access-control cannot
    // see it, so the edge — the only place holding both answers — adds the role. This is a
    // display/derivation step; the permissions stay exactly access-control's answer.
    const roles = effectiveRoles({ status: user.status, roles: grants.roles });

    return {
      user,
      roles,
      permissions: grants.permissions,
      actorKind: actorKindOf({ status: user.status, roles }),
      sessionId: principal.sessionId,
    };
  }

  /**
   * Registers an account. No credential, no session — see identity's `CreateUser`.
   *
   * @remarks The default role is granted here rather than left for a later operator: every
   * account-creation path through this edge goes through this method, and an account with no
   * role is an account whose owner cannot perform the actions their sign-up promised. The
   * grant is idempotent, so a retry after a lost response leaves one assignment.
   */
  async createUser(input: GatewayUserInput): Promise<GatewayUser> {
    const user = await this.identity.createUser(input);
    await grantSignupRole(this.accessControl, this.logger, user.id, 'user-provisioning');
    return user;
  }

  /**
   * One account, for a caller access-control has already allowed to read accounts.
   *
   * @remarks A pass-through to identity: the gateway holds no user data and cannot answer
   * from a cache that identity does not know about. The permission check belongs to the
   * route, not here — a facade that re-checked would be a second authority, and the one the
   * route decorator states is the one an operator can read.
   */
  async getUser(userId: string): Promise<GatewayUser> {
    return this.identity.getUser(userId);
  }

  /**
   * The role catalogue, as access-control holds it.
   *
   * @remarks Read-only and paged. The gateway could answer from the static `SYSTEM_ROLES`
   * catalogue, but that would hide every custom role — the ones an operator actually needs
   * to grant. The service that owns assignments owns the list.
   */
  async listRoles(input: {
    search?: string;
    page?: number;
    limit?: number;
  } = {}) {
    return this.accessControl.listRoles(input);
  }

  /**
   * Adds a role on behalf of the caller, who the guard has already authorised.
   *
   * @remarks `grantedBy` is the authenticated principal, never a body field: an audit trail
   * that lets the caller name somebody else is not an audit trail. Access-control treats the
   * grant as idempotent and answers with the whole set, which is what the edge returns.
   */
  async grantRole(
    principal: GatewayPrincipal,
    input: { userId: string; role: string },
  ): Promise<{ userId: string; roles: readonly string[] }> {
    const roles = await this.accessControl.grantRole({
      userId: input.userId,
      role: input.role,
      grantedBy: principal.userId,
    });

    return { userId: input.userId, roles };
  }

  /** Removes a role and answers with the roles that remain. */
  async revokeRole(
    input: { userId: string; role: string },
  ): Promise<{ userId: string; roles: readonly string[] }> {
    const roles = await this.accessControl.revokeRole(input);
    return { userId: input.userId, roles };
  }

  /**
   * The browser's placeholder account, renewed or minted.
   *
   * @remarks A pass-through on purpose: whether the presented id still names a live guest row
   * is identity's check, made where the row lives. An edge that answered that question from
   * a stale read would be one replication delay away from handing back a reaped id — or, if it
   * answered wrongly in the other direction, from abandoning a guest the browser still holds.
   */
  async acquireGuestUser(userId?: string): Promise<GatewayUser> {
    return this.identity.acquireGuestUser(userId);
  }

  /**
   * Creates an account *and* its first password, then signs the caller in — one request, in
   * that order, for a reason worth stating.
   *
   * @remarks The credential is stored first, against a freshly chosen id, and only then does
   * the account claim that id. credential-vault does not care whether the user exists yet —
   * registration is an anticipated caller — but the reverse order would: the vault's policy
   * (length, composition, whatever an operator configures next) lives in the vault, so every
   * refusal there would land *after* an account row exists, leaving half an account on every
   * weak password. This order fails towards a credential nothing points at, which this method
   * revokes on refusal and which nothing could log in with regardless.
   *
   * @remarks A refusal on the address — the ordinary duplicate — is that same compensation:
   * identity refuses, the orphan credential is revoked, and the original 409 travels to the
   * caller unchanged. A session that cannot be minted after both writes is a *complete*
   * account, and the caller can simply sign in, so it is not compensated back to nothing.
   */
  async register(input: RegisterInput): Promise<LoginResult> {
    const userId = randomUUID();

    await this.credentials.setPassword({ userId, newPassword: input.password });

    try {
      await this.identity.createUser({
        id: userId,
        email: input.email,
        displayName: input.displayName,
        locale: input.locale,
        source: USER_SOURCE_WEB,
      });
    } catch (error) {
      await this.credentials
        .revokeAll({ userId, reason: 'registration_refused' })
        .catch(() => undefined);
      throw error;
    }

    // The account exists; it now receives the baseline role before a session is minted, so
    // "signed in" and "authorised as a user" cannot disagree from the first request on.
    await grantSignupRole(this.accessControl, this.logger, userId, 'self-registration');

    return this.sessions.issueTokens({
      userId,
      email: input.email,
      ipAddress: input.ipAddress,
    });
  }


  /**
   * Sets the initial password for an account.
   *
   * @remarks Provisioning, not proof of possession, which is why the route in front of this
   * carries a permission rather than assuming the caller's own id: who is allowed to set
   * somebody's password is access-control's question, and the gateway asks it.
   */
  async setPassword(input: {
    userId: string;
    newPassword: string;
  }): Promise<{ userId: string; credentialId: string }> {
    const { credentialId } = await this.credentials.setPassword({
      userId: input.userId,
      newPassword: input.newPassword,
    });

    return { userId: input.userId, credentialId };
  }
}

/**
 * Reads the token pair off a completed flow.
 *
 * @remarks A `completed` state with no access token would be a peer lying about the outcome,
 * so it is refused rather than passed on. The alternative — returning an empty token pair —
 * hands the caller a session that cannot authenticate anything, and the failure surfaces
 * later as a mystery 401 on the next request.
 */
function toLoginResult(outcome: FlowProgress): LoginResult {
  if (!outcome.accessToken || !outcome.refreshToken) {
    throw new InvalidCredentialsException('the sign-in did not produce a token pair');
  }

  return {
    accessToken: outcome.accessToken,
    refreshToken: outcome.refreshToken,
    expiresIn: outcome.expiresIn ?? 0,
    sessionId: outcome.sessionId ?? '',
  };
}
