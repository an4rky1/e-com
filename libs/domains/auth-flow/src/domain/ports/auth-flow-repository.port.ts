/**
 * @fileoverview Storage for the flow and its audit trail.
 *
 * @remarks `save` takes the whole aggregate and promises three things together: the row, every
 * new step, and the outbox envelope for each event. Splitting them leaves a window in which a
 * flow has moved but nothing has heard about it — or, worse, in which it reached `completed`
 * and the audit trail that explains why does not exist.
 */
import type { AuthFlow } from '../auth-flow.aggregate';

export const AUTH_FLOW_REPOSITORY = Symbol('AUTH_FLOW_REPOSITORY');

export interface AuthFlowRepositoryPort {
  /**
   * Persists the flow, its new steps and its pending events in one transaction.
   *
   * @remarks Draining the aggregate's events is the repository's job, exactly as in identity:
   * forgetting it is how a duplicate `auth_flow.completed` appears for one login.
   */
  save(flow: AuthFlow): Promise<void>;

  /** Loads the flow with its steps, or `null` if there is no such id. */
  findById(id: string): Promise<AuthFlow | null>;

  /** Flows that are still open past their lifetime — the work a sweep has left to do. */
  countActive(now: Date): Promise<number>;
}