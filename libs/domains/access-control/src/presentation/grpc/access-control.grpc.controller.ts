import { Controller } from '@nestjs/common';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  CheckPermissionRequest,
  CheckPermissionResponse,
  EvaluatePolicyRequest,
  EvaluatePolicyResponse,
  GetPermissionsRequest,
  GetPermissionsResponse,
  GrantRoleRequest,
  GrantRoleResponse,
  RevokeRoleRequest,
} from '@auth/contracts';
// Value import: constructor-injected; a type-only import erases the DI token.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { AccessControlService } from '../../application/facade/access-control.service';

const SERVICE = 'AccessControlService';

/**
 * gRPC transport for access control.
 *
 * @remarks "What may this user do?" is a question with an answer the caller needs in order to
 * continue, so it is a synchronous call rather than an event. Every other service depends on
 * this surface instead of reading the database — which is what keeps the `access_control`
 * schema private to this service.
 *
 * @remarks The methods carry no permission metadata of their own. A gRPC method is guarded by
 * whichever transport the caller came through; requiring a decorator here as well would give
 * the same route two authorities, and the weaker one would be the one somebody forgets.
 */
// Own `@Controller()` rather than inheriting it from the base: `emitDecoratorMetadata`
// does NOT inherit across class inheritance, so without a decorator on *this* class
// TypeScript emits no `design:paramtypes`, Nest constructs it with no arguments, and
// every injected dependency arrives `undefined` — at call time, not at boot.
@Controller()
export class AccessControlGrpcController extends GrpcControllerBase {
  constructor(private readonly accessControl: AccessControlService) {
    super();
  }

  @GrpcMethod(SERVICE, 'GetPermissions')
  async getPermissions(request: GetPermissionsRequest): Promise<GetPermissionsResponse> {
    const model = await this.accessControl.getUserPermissions(request.userId);
    return {
      roles: model.roles.map((role) => role.name),
      permissions: model.permissions,
    };
  }

  @GrpcMethod(SERVICE, 'CheckPermission')
  async checkPermission(
    request: CheckPermissionRequest,
  ): Promise<CheckPermissionResponse> {
    const decision = await this.accessControl.checkPermission({
      userId: request.userId,
      permission: request.permission,
      context: request.context ?? {},
    });

    return { allowed: decision.allowed, reason: decision.reason };
  }

  @GrpcMethod(SERVICE, 'GrantRole')
  async grantRole(request: GrantRoleRequest): Promise<GrantRoleResponse> {
    await this.accessControl.grantRoleToUser({
      userId: request.userId,
      role: request.role,
      grantedBy: request.grantedBy,
    });

    // The response is the *whole* role set rather than the delta: a caller that applies a
    // partial grant has to reconcile two lists, and gets it wrong exactly when a grant is
    // the operation that matters most.
    return { roles: await this.roleNamesOf(request.userId) };
  }

  @GrpcMethod(SERVICE, 'RevokeRole')
  async revokeRole(request: RevokeRoleRequest): Promise<GrantRoleResponse> {
    await this.accessControl.revokeRoleFromUser({
      userId: request.userId,
      role: request.role,
    });

    return { roles: await this.roleNamesOf(request.userId) };
  }

  /**
   * Evaluates the rules that apply to a policy name.
   *
   * @remarks The named policy selects the *question* ("is this rule in force for this
   * resource?"), not the answer: the answer comes from evaluating every rule attached to the
   * user's roles, because a deny held by another role still applies. Answering from the named
   * policy alone would let a caller check the allow it can see while the deny goes unread.
   */
  @GrpcMethod(SERVICE, 'EvaluatePolicy')
  async evaluatePolicy(
    request: EvaluatePolicyRequest,
  ): Promise<EvaluatePolicyResponse> {
    const model = await this.accessControl.getUserPermissions(request.userId);
    const policy = model.policies.find((candidate) => candidate.id === request.policy);

    const decision = await this.accessControl.checkPermission({
      userId: request.userId,
      permission: policy?.permission ?? request.policy,
      context: { ...(request.resource ?? {}), ...(request.context ?? {}) },
    });

    return {
      allowed: decision.allowed,
      reason: policy
        ? decision.reason
        : `no policy "${request.policy}" is attached to a held role; evaluated "${request.policy}" as a permission`,
    };
  }

  private async roleNamesOf(userId: string): Promise<string[]> {
    const model = await this.accessControl.getUserPermissions(userId);
    return model.roles.map((role) => role.name);
  }
}
