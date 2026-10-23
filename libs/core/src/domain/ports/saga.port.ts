/**
 * @fileoverview Composite transaction helper and the saga primitives that sit above it.
 *
 * Why: multi-service writes cannot share a SQL transaction, so a distributed operation is
 * modelled as forward steps plus compensating steps. Declaring the compensation explicitly
 * is what keeps "we half-registered the user" from being an unrecoverable state.
 */

export interface ISagaStep<TContext> {
  readonly name: string;
  execute(context: TContext): Promise<TContext>;
  /** Undoes `execute`. Must be safe to call after a partial failure. */
  compensate(context: TContext): Promise<TContext>;
}

export interface ISaga<TContext> {
  readonly sagaId: string;
  readonly steps: ReadonlyArray<ISagaStep<TContext>>;
  execute(context: TContext): Promise<TContext>;
  /** Reverse-order compensation for the steps that already ran. */
  compensate(context: TContext): Promise<TContext>;
}

export class SagaOrchestrator<TContext> {
  constructor(
    private readonly sagaId: string,
    private readonly steps: ISagaStep<TContext>[] = [],
  ) {}

  addStep(step: ISagaStep<TContext>): this {
    this.steps.push(step);
    return this;
  }

  /**
   * Runs steps forward, compensating in reverse if any step fails.
   *
   * @remarks Compensation failures are collected rather than thrown, so one broken step
   * cannot prevent the remaining undo operations from running — and the caller sees the
   * full picture of what went wrong.
   */
  async execute(context: TContext): Promise<TContext> {
    const executed: ISagaStep<TContext>[] = [];
    let current = context;

    for (const step of this.steps) {
      try {
        current = await step.execute(current);
        executed.push(step);
      } catch (error) {
        // Reverse order: step `b` may depend on the state step `a` created, so undoing `a`
        // first can leave `b`'s compensation working against a state that no longer exists.
        const { errors } = await this.runCompensation(current, [...executed].reverse());
        throw new SagaExecutionError(this.sagaId, step.name, error, errors);
      }
    }

    return current;
  }

  async compensate(context: TContext): Promise<TContext> {
    const { context: restored } = await this.runCompensation(context, [
      ...this.steps,
    ].reverse());
    return restored;
  }

  private async runCompensation(
    context: TContext,
    steps: ISagaStep<TContext>[],
  ): Promise<{ context: TContext; errors: unknown[] }> {
    let current = context;
    const errors: unknown[] = [];

    for (const step of steps) {
      try {
        current = await step.compensate(current);
      } catch (error) {
        // A failed compensation must not abort the remaining ones: every later undo
        // restores state that this one was supposed to unwind. The failure is collected
        // so the caller learns that manual intervention is needed.
        errors.push(error);
      }
    }

    return { context: current, errors };
  }
}

export class SagaExecutionError extends Error {
  override readonly name = 'SagaExecutionError';

  constructor(
    readonly sagaId: string,
    readonly failedStep: string,
    override readonly cause: unknown,
    readonly compensationErrors: unknown[],
  ) {
    super(
      `Saga "${sagaId}" failed at step "${failedStep}"; ${compensationErrors.length} compensation(s) also failed`,
    );
  }
}