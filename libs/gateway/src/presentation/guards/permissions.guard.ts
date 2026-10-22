/**
 * @fileoverview Asks access-control whether this caller may proceed, and forwards the answer.
 *
 * @remarks **This guard contains no policy.** It does not know what `users:write` means, which
 * role grants it, or what a caller with no roles may do — those are access-control's data, and
 * a copy of them here would be one more thing to keep in step. The guard's whole job is to
 * carry the question across and to translate the answer into an HTTP status.
 *
 * @remarks That is also why it uses `CheckPermission` per permission rather than
 * `GetPermissions` and a `Set` lookup. Both produce the same allow/deny today, but only one
 * of them asks the service that owns ABAC rules, so only one stays correct when a decision
 * starts depending on something other than the user's grants.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
// Value import on purpose — see the note in `auth.controller.ts`: a type-only import
 // erases the DI token and the service then boots with an undefined facade.
 // eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import {
  PermissionDeniedException,
  TokenInvalidException,
} from '@auth/platform/error-handling';
import {
  ACCESS_CONTROL_CLIENT,
  type AccessControlClientPort,
} from '../../application/ports/peer-clients.port';
import { REQUIRED_PERMISSIONS } from '../decorators/route-metadata';
import type { GatewayRequest } from '../gateway-request';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_CONTROL_CLIENT)
    private readonly accessControl: AccessControlClientPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_PERMISSIONS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    // No declaration, no question. A route that needs a permission says so; this is not a
    // place to infer one from the HTTP method.
    if (required.length === 0) return true;

    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const principal = request.principal;
    if (!principal) {
      // Reaching here means the guard was mounted without `JwtAuthGuard` in front of it, so
      // "ask access-control on whose behalf?" has no answer. Refuse rather than guess.
      throw new TokenInvalidException('no authenticated principal on this request', {
        hint: 'a guarded route must sit behind JwtAuthGuard',
      });
    }

    for (const permission of required) {
      const decision = await this.accessControl.checkPermission({
        userId: principal.userId,
        permission,
      });

      if (!decision.allowed) {
        throw new PermissionDeniedException('insufficient permissions', {
          permission,
          // Access control writes this for operators, and it is a reason code rather than a
          // free-text field, so it is safe to relay where a raw error message would not be.
          reason: decision.reason,
        });
      }
    }

    return true;
  }
}
