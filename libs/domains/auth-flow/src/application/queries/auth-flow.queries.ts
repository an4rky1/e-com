/**
 * @fileoverview Reading a flow back.
 *
 * @remarks A query, not a command: reading a flow changes nothing and writes nothing, and
 * routing it through the command bus would have the side effect of implying otherwise.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import type { AuthFlow } from '../../domain/auth-flow.aggregate';
import {
  AUTH_FLOW_REPOSITORY,
  type AuthFlowRepositoryPort,
} from '../../domain/ports/auth-flow-repository.port';
import {
  isRetryable,
  messageFor,
  type FlowOutcome,
} from '../commands/auth-flow.commands';

export class GetFlowQuery extends Query<FlowOutcome | null> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly flowId: string) {
    super();
  }
}

@Injectable()
@QueryHandler(GetFlowQuery)
export class GetFlowHandler implements IQueryHandler<GetFlowQuery, FlowOutcome | null> {
  constructor(
    @Inject(AUTH_FLOW_REPOSITORY) private readonly flows: AuthFlowRepositoryPort,
  ) {}

  /**
   * Returns `null` rather than throwing for an unknown id.
   *
   * @remarks This backs a "where am I?" poll from a sign-in form, which runs before anybody
   * has proved anything. Making it throw would turn a stale tab into an error page.
   *
   * @remarks Never carries a session. Tokens exist only in the response to the request that
   * earned them; a page reloaded halfway through a sign-in cannot go back and collect them.
   */
  async execute(query: GetFlowQuery): Promise<FlowOutcome | null> {
    const flow = await this.flows.findById(query.flowId);
    return flow ? toOutcome(flow) : null;
  }
}

function toOutcome(flow: AuthFlow): FlowOutcome {
  return {
    flowId: flow.id.value,
    flow: flow.flow,
    state: flow.state,
    message: messageFor(flow.state),
    retryable: isRetryable(flow.state),
    session: null,
    locked: false,
    retryAfterSeconds: 0,
  };
}