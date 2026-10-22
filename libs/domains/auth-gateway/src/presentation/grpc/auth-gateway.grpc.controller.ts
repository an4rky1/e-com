/**
 * @fileoverview gRPC transport for the auth gateway.
 *
 * @remarks Every method answers with a `FlowResponse` even when the flow ended badly. That is
 * not politeness: `failed`, `expired` and `cancelled` are *outcomes of a walk someone started*,
 * not transport errors, and a caller that has to tell them apart from a 500 has lost the one
 * thing this service exists to tell it — which step to show next.
 *
 * @remarks The one exception is a flow id that does not exist. That is a client bug rather
 * than an authentication result, and it is raised as NOT_FOUND, which the retry registry
 * classifies as fatal and never retries.
 */
import { Controller } from '@nestjs/common';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  AdvanceFlowRequest,
  FlowResponse,
  StartFlowRequest,
} from '@auth/contracts';
// Value import: constructor-injected, and `emitDecoratorMetadata` reads the value
// binding — a type-only import leaves Nest with `Object` and an undefined facade.
import { AuthGatewayService } from '../../application/facade/auth-gateway.service';
import { toFlowResponse } from '../dto/auth-flow.dto';

const SERVICE = 'AuthGatewayService';

/**
 * `GetFlowRequest` / `CancelFlowRequest`, spelled out here.
 *
 * @remarks `libs/contracts/src/grpc/service-contracts.ts` declares these two inline on
 * `AuthGatewayGrpcClient` rather than exporting named interfaces, so there is nothing to import.
 * Duplicating two field names is cheaper than widening a shared contract for one caller, and
 * this file stays the single place a drift against `auth_gateway.proto` would show up.
 */
interface GetFlowRequest {
  flowId: string;
}

interface CancelFlowRequest {
  flowId: string;
  reason: string;
}

// Own `@Controller()` rather than inheriting it from the base: `emitDecoratorMetadata`
// does NOT inherit across class inheritance, so without a decorator on *this* class
// TypeScript emits no `design:paramtypes`, Nest constructs it with no arguments, and
// every injected dependency arrives `undefined` — at call time, not at boot.
@Controller()
export class AuthGatewayGrpcController extends GrpcControllerBase {
  constructor(private readonly gateway: AuthGatewayService) {
    super();
  }

  @GrpcMethod(SERVICE, 'StartFlow')
  async startFlow(request: StartFlowRequest): Promise<FlowResponse> {
    return toFlowResponse(
      await this.gateway.startFlow({
        flow: request.flow,
        email: request.email,
        // A step-up is the one flow that cannot be started from an address: the caller already
        // knows whose account it is re-proving. `StartFlowRequest` has no `user_id` field, so it
        // travels in the metadata map rather than being smuggled in as a device fingerprint —
        // the proto is shared, and quietly redefining one of its fields here would make the
        // gateway's contract unreadable at the service that depends on it.
        userId: request.metadata?.['userId'],
        clientIp: request.ipAddress,
        userAgent: request.userAgent,
        deviceId: request.deviceFingerprint,
      }),
    );
  }

  @GrpcMethod(SERVICE, 'AdvanceFlow')
  async advanceFlow(request: AdvanceFlowRequest): Promise<FlowResponse> {
    return toFlowResponse(
      await this.gateway.advanceFlow({
        flowId: request.flowId,
        credential: request.credential,
      }),
    );
  }

  @GrpcMethod(SERVICE, 'GetFlow')
  async getFlow(request: GetFlowRequest): Promise<FlowResponse> {
    const outcome = await this.gateway.getFlow(request.flowId);
    if (!outcome) {
      throw new ResourceNotFoundException('auth flow not found', {
        flowId: request.flowId,
      });
    }
    return toFlowResponse(outcome);
  }

  @GrpcMethod(SERVICE, 'CancelFlow')
  async cancelFlow(request: CancelFlowRequest): Promise<FlowResponse> {
    return toFlowResponse(
      await this.gateway.cancelFlow({
        flowId: request.flowId,
        reason: request.reason,
      }),
    );
  }
}