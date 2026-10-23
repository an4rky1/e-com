import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
// Value import: constructor-injected. `emitDecoratorMetadata` reads the emitted value
// binding, so a type-only import erases the DI token and Nest cannot resolve it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { Reflector } from '@nestjs/core';
import { PermissionDeniedException } from '@auth/platform/error-handling';
import type { PermissionDecision } from '../../domain/permission-evaluator';
import {
  REQUIRED_PERMISSIONS,
  type PermissionRequirement,
} from '../decorators/require-permissions.decorator';
import {
  PERMISSION_CHECKER,
  type PermissionChecker,
} from './permission-checker.port';

/** The authenticated principal, as the gateway's authentication guard leaves it. */
export interface AuthenticatedPrincipal {
  userId?: string;
  sub?: string;
  /** Permissions already baked into a verified token, used to skip the round trip. */
  permissions?: readonly string[];
}

/** The slice of the inbound request this guard reads. */
interface InboundRequest {
  user?: unknown;
  /** ABAC attributes: ip, tenant, resourceType, … */
  attributes?: unknown;
}

@Injectable()
export class AccessControlGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PERMISSION_CHECKER) private readonly permissions: PermissionChecker,
  ) {}

  /**
   * Enforces {@link RequirePermissions} on a route.
   *
   * @remarks Reused verbatim by the api-gateway: the decorator and the guard are the contract
   * between "a route needs this" and "the request gets refused without it", and shipping two
   * copies of that pair is how they stop agreeing.
   *
   * @remarks It throws {@link PermissionDeniedException} rather than returning `false`. Both
   * refuse the request; the exception carries a typed code, so the filter renders 403 and an
   * audit hook sees `PERMISSION_DENIED` instead of an anonymous `false`.
   *
   * @remarks A route with no metadata and no principal is **denied**, not allowed. Failing open
   * on a missing decorator would make the safe case — someone adds a route and forgets — the
   * one that leaks.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<
      PermissionRequirement | undefined
    >(REQUIRED_PERMISSIONS, [context.getHandler(), context.getClass()]);

    const request = requestOf(context);
    const principal = principalOf(request);

    if (!principal) {
      // Refused with the same exception as any other denial, so a caller cannot tell "you are
      // not logged in" from "you may not do that" by the shape of the error.
      throw new PermissionDeniedException('authentication is required', {
        required: requirement ? [...requirement.permissions] : [],
      });
    }

    // No requirement expressed at all: an authenticated caller is allowed through. The way to
    // say "no check needed" is `@PublicEndpoint()`; a route nobody annotated is not public.
    if (!requirement || requirement.permissions.length === 0) {
      return true;
    }

    const userId = principal.userId ?? principal.sub;
    if (!userId) {
      throw new PermissionDeniedException('the principal carries no subject', {
        required: [...requirement.permissions],
      });
    }

    const decisions = await Promise.all(
      requirement.permissions.map((permission) =>
        this.check(userId, permission, principal, attributesOf(request)),
      ),
    );

    const satisfied =
      requirement.mode === 'all'
        ? decisions.every((decision) => decision.allowed)
        : decisions.some((decision) => decision.allowed);

    if (satisfied) return true;

    // The evaluator's reason is deliberately absent from the thrown message: it names the
    // rule that refused, which is exactly what an attacker should not be told.
    throw new PermissionDeniedException('the caller lacks the required permission', {
      userId,
      required: [...requirement.permissions],
      mode: requirement.mode,
    });
  }

  /**
   * One decision per permission.
   *
   * @remarks Permissions already on a verified token are trusted without a round trip. The
   * token was signed by this platform's session engine from a `role.granted` event, so it is
   * a cache of the answer — and a cache that is never consulted is an extra query on every
   * request.
   */
  private async check(
    userId: string,
    permission: string,
    principal: AuthenticatedPrincipal,
    attributes: Record<string, string>,
  ): Promise<PermissionDecision> {
    if (principal.permissions?.includes(permission)) {
      return { allowed: true, reason: 'carried by the verified token' };
    }

    return this.permissions.checkPermission({ userId, permission, context: attributes });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const requestOf = (context: ExecutionContext): InboundRequest => {
  const request: unknown = context.switchToHttp().getRequest();
  return isRecord(request) ? (request as InboundRequest) : {};
};

const principalOf = (request: InboundRequest): AuthenticatedPrincipal | null =>
  isRecord(request.user) ? (request.user as AuthenticatedPrincipal) : null;

const attributesOf = (request: InboundRequest): Record<string, string> =>
  isRecord(request.attributes)
    ? (request.attributes as Record<string, string>)
    : {};