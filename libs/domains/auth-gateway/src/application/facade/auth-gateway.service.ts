/**
 * @fileoverview The only public surface of the auth-gateway module.
 *
 * @remarks Controllers, gRPC handlers and other services depend on this class and nothing
 * else. They therefore cannot reach the repository, the CQRS bus, the ports or the aggregate —
 * which is what makes the module's internals replaceable without touching a single caller.
 */
import { Injectable } from '@nestjs/common';
// Value import, not `import type`: these are constructor-injected, and
// `emitDecoratorMetadata` reads the emitted value binding to resolve them.
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  AdvanceFlowCommand,
  CancelFlowCommand,
  StartFlowCommand,
  type FlowOutcome,
} from '../commands/auth-flow.commands';
import { GetFlowQuery } from '../queries/auth-flow.queries';

@Injectable()
export class AuthGatewayService {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  startFlow(input: {
    flow: string;
    email: string;
    userId?: string;
    clientIp?: string;
    userAgent?: string;
    deviceId?: string;
  }): Promise<FlowOutcome> {
    return this.commandBus.execute<FlowOutcome>(
      new StartFlowCommand(
        input.flow,
        input.email,
        input.userId,
        input.clientIp,
        input.userAgent,
        input.deviceId,
      ),
    );
  }

  advanceFlow(input: {
    flowId: string;
    credential: string;
  }): Promise<FlowOutcome> {
    return this.commandBus.execute<FlowOutcome>(
      new AdvanceFlowCommand(input.flowId, input.credential),
    );
  }

  cancelFlow(input: { flowId: string; reason: string }): Promise<FlowOutcome> {
    return this.commandBus.execute<FlowOutcome>(
      new CancelFlowCommand(input.flowId, input.reason),
    );
  }

  getFlow(flowId: string): Promise<FlowOutcome | null> {
    return this.queryBus.execute(new GetFlowQuery(flowId));
  }
}

export type { FlowOutcome };