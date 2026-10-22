/**
 * @fileoverview Enforces "a second factor was proven" on a route.
 *
 * @remarks Reused verbatim by auth-gateway and by any service that fronts a sensitive action,
 * for the same reason {@link AccessControlGuard} is: two copies of a security guard are two
 * implementations that will eventually disagree about what "protected" means.
 *
 * @remarks Three ways through, in order of cost:
 *
 * 1. `@SkipMfa()` on the route — no check at all.
 * 2. The principal already carries `mfaVerified`, because this request *is* the second step
 *    of a sign-in. Nothing is re-computed; a user is not asked for two codes in a row.
 * 3. A code is present on the request, and {@link MfaChallengePort} is asked whether it
 *    proves possession. This is the step-up path: a long-lived session re-proving before
 *    something sensitive.
 */

import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
// Value import: `Reflector` is constructor-injected and `emitDecoratorMetadata`
// reads the value binding, so a type-only import erases the DI token.
import { Reflector } from '@nestjs/core';
import { MfaRequiredException } from '@auth/platform/error-handling';
import {
  MFA_CHALLENGE,
  type MfaChallengePort,
} from '../../domain/ports/mfa-challenge.port';
import { SKIP_MFA } from '../decorators/skip-mfa.decorator';

/**
 * The authenticated principal, as the authentication guard leaves it.
 *
 * @remarks `mfaVerified` is a claim, not a fact this service can check: by the time the
 * request arrives, the code that proved the second factor has been spent and cannot be
 * presented again. The gateway is the only party that watched that happen, which is why the
 * field is read rather than recomputed.
 */
export interface MfaPrincipal {
  readonly userId?: string;
  readonly sub?: string;
  /** Set once a second factor has been proven for this request or its session. */
  readonly mfaVerified?: boolean;
  /** Some issuers name it differently; both are read, neither is invented. */
  readonly amr?: readonly string[];
}

/** The slice of the inbound request this guard reads. */
interface InboundRequest {
  readonly user?: unknown;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly headers?: unknown;
}

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(MFA_CHALLENGE) private readonly challenge: MfaChallengePort,
  ) {}

  /**
   * @throws {MfaRequiredException} when no second factor could be established.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(SKIP_MFA, [
      context.getHandler(),
      context.getClass(),
    ])) {
      return true;
    }

    const request = requestOf(context);
    const principal = principalOf(request);

    if (!principal) {
      // The same exception as a failed challenge: an endpoint that distinguishes "who are
      // you" from "prove more" is an endpoint that enumerates accounts.
      throw new MfaRequiredException('a second factor is required', {});
    }

    if (principal.mfaVerified === true || namesMfa(principal)) {
      return true;
    }

    const userId = principal.userId ?? principal.sub;
    const code = codeOf(request);
    if (!userId || !code) {
      throw new MfaRequiredException('a second factor is required', { userId: userId ?? null });
    }

    if (await this.challenge.verifyOwnership({ userId, code })) {
      return true;
    }

    throw new MfaRequiredException('a second factor is required', { userId });
  }
}

/** `amr: ['pwd', 'otp']` is the OIDC spelling of "the second factor was proven". */
const namesMfa = (principal: MfaPrincipal): boolean =>
  Array.isArray(principal.amr) && principal.amr.some((entry) => entry === 'otp' || entry === 'mfa');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const requestOf = (context: ExecutionContext): InboundRequest => {
  const request: unknown = context.switchToHttp().getRequest();
  return isRecord(request) ? (request as InboundRequest) : {};
};

const principalOf = (request: InboundRequest): MfaPrincipal | null =>
  isRecord(request.user) ? (request.user as MfaPrincipal) : null;

/**
 * Reads a submitted code from wherever a client put it.
 *
 * @remarks Three transports, one lookup: a JSON body for the HTTP API, a query parameter for
 * links, and the `x-mfa-code` header for callers that must not put a credential in a URL. The
 * header wins, because a URL ends up in access logs and browser history.
 */
const codeOf = (request: InboundRequest): string | null => {
  const headers = isRecord(request.headers) ? request.headers : {};
  const header = headers['x-mfa-code'] ?? headers['X-Mfa-Code'];

  const body = isRecord(request.body) ? request.body : {};
  const query = isRecord(request.query) ? request.query : {};

  for (const candidate of [header, body.mfaCode, body.code, query.mfa_code]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
};