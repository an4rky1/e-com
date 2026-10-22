/**
 * @fileoverview The three things a caller can ask of a flow.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a REST
 * field never reaches the domain.
 *
 * @remarks A class, not an interface. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off whatever it is given. A
 * plain object literal or a string key therefore cannot dispatch at all — `@CommandHandler('Name')`
 * throws at import, because `Reflect.hasOwnMetadata` rejects a non-object.
 */
import { Command } from '@nestjs/cqrs';
import {
  AuthFlowState,
  type AuthFlowState as AuthFlowStateT,
} from '../../domain/value-objects/auth-flow-state.vo';
import type { AuthFlowType } from '../../domain/value-objects/auth-flow-type.vo';
import type { IssuedTokens } from '../../domain/ports/session.port';

/**
 * What a caller learns about a flow.
 *
 * @remarks Not the gRPC message. The transport type has every field optional and cannot say
 * "there is no session here"; this one can, which is what stops the controller from having to
 * infer it from an empty string.
 *
 * @remarks `message` is written for the person on the other end of the sign-in form, and the
 * handlers keep it deliberately vague: a wrong password, an unknown address and a locked
 * account must all read the same, or the endpoint becomes an account-existence oracle.
 */
export interface FlowOutcome {
  readonly flowId: string;
  readonly flow: AuthFlowType;
  readonly state: AuthFlowStateT;
  readonly message: string;
  /** Whether the caller may usefully try again with the *same* flow. */
  readonly retryable: boolean;
  readonly session: IssuedTokens | null;
  /** The report account-security made about the attempt that just happened. */
  readonly locked: boolean;
  readonly retryAfterSeconds: number;
}

export class StartFlowCommand extends Command<FlowOutcome> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    /** `login`, `register`, `reset_password`, `magic_link` or `step_up`. */
    readonly flow: string,
    readonly email: string,
    /** Required by `step_up`, ignored otherwise — a step-up already knows who it is for. */
    readonly userId?: string,
    readonly clientIp?: string,
    readonly userAgent?: string,
    readonly deviceId?: string,
  ) {
    super();
  }
}

export class AdvanceFlowCommand extends Command<FlowOutcome> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly flowId: string,
    /** Password, OTP, backup code or magic token — whichever the flow's state is waiting for. */
    readonly credential: string,
  ) {
    super();
  }
}

export class CancelFlowCommand extends Command<FlowOutcome> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly flowId: string,
    readonly reason: string,
  ) {
    super();
  }
}

/** The message a person sees for each terminal or waiting state. */
export const FlowMessage = {
  AWAITING_CREDENTIAL: 'enter your password to continue',
  AWAITING_2FA: 'enter the code from your authenticator app',
  AWAITING_STEP_UP: 'confirm that this is you to continue',
  COMPLETED: 'you are signed in',
  /** One string for every refusal, on purpose. See {@link FlowOutcome}. */
  FAILED: 'those details were not accepted',
  EXPIRED: 'this attempt has expired; please start again',
  CANCELLED: 'this attempt was cancelled',
} as const;

/** Whether the caller may re-send a credential against the same flow row. */
export function isRetryable(state: AuthFlowStateT): boolean {
  return state === AuthFlowState.AWAITING_CREDENTIAL;
}

export function messageFor(state: AuthFlowStateT): string {
  switch (state) {
    case AuthFlowState.AWAITING_CREDENTIAL:
      return FlowMessage.AWAITING_CREDENTIAL;
    case AuthFlowState.AWAITING_2FA:
      return FlowMessage.AWAITING_2FA;
    case AuthFlowState.AWAITING_STEP_UP:
      return FlowMessage.AWAITING_STEP_UP;
    case AuthFlowState.COMPLETED:
      return FlowMessage.COMPLETED;
    case AuthFlowState.FAILED:
      return FlowMessage.FAILED;
    case AuthFlowState.EXPIRED:
      return FlowMessage.EXPIRED;
    case AuthFlowState.CANCELLED:
      return FlowMessage.CANCELLED;
  }
}