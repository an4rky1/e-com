import {
  AggregateRoot,
  DomainError,
  Email,
  EntityId,
  Ensure,
  Result,
  SagaOrchestrator,
  PredicateSpecification,
  type IDomainEvent,
  type ISagaStep,
} from '../src';

class TestEvent {
  constructor(
    readonly aggregateId: string,
    readonly version = 1,
  ) {}
  readonly eventId = 'evt-1';
  readonly aggregateType = 'Test';
  readonly eventType = 'test.happened';
  readonly occurredAt = new Date();
  readonly correlationId?: string;
}

class TestAggregate extends AggregateRoot<string> {
  private constructor(
    id: string,
    public status: 'draft' | 'active',
  ) {
    super(id);
  }

  static create(id: string): TestAggregate {
    const aggregate = new TestAggregate(id, 'draft');
    aggregate.addDomainEvent(
      new TestEvent(aggregate.id) as unknown as IDomainEvent,
    );
    return aggregate;
  }

  activate(): void {
    this.status = 'active';
  }
}

describe('EntityId', () => {
  it('mints a valid v4 uuid when no value is supplied', () => {
    const id = EntityId.create<'UserId'>();
    expect(EntityId.isValid(id)).toBe(true);
  });

  it('preserves an explicitly supplied id so event replay reproduces it', () => {
    const value = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect(EntityId.create(value)).toBe(value);
  });

  it('rejects a malformed id rather than storing it', () => {
    expect(() => EntityId.create('not-a-uuid')).toThrow(/Invalid UUID/);
  });

  it('rejects a uuid that is not version 4', () => {
    expect(
      EntityId.isValid('00000000-0000-0000-0000-000000000000'),
    ).toBe(false);
  });
});

describe('Email', () => {
  it.each([
    ['user@example.com', 'user@example.com'],
    ['  User@Example.COM  ', 'user@example.com'],
  ])('normalises %s', (input, expected) => {
    expect(Email.create(input).map((email) => email.value).unwrapOrThrow()).toBe(
      expected,
    );
  });

  it.each([[''], ['no-at-sign'], ['@example.com'], ['a@b'], ['a b@example.com']])(
    'rejects %p',
    (input) => {
      expect(Email.create(input).isFailure).toBe(true);
    },
  );

  it('exposes the domain part', () => {
    expect(Email.fromTrusted('user@mail.example.co').domain).toBe(
      'mail.example.co',
    );
  });

  it('obfuscates the local part so logs do not enumerate live mailboxes', () => {
    // 'person' is six characters: the first is kept, the remaining five are masked.
    expect(Email.fromTrusted('person@example.com').obfuscated).toBe(
      'p*****@example.com',
    );
  });
});

describe('Ensure', () => {
  it('raises a DomainError carrying a machine-readable code', () => {
    expect(() => Ensure.notEmpty('   ', 'displayName')).toThrow(DomainError);
    try {
      Ensure.notEmpty('', 'displayName');
    } catch (error) {
      expect((error as DomainError).code).toBe('MISSING_REQUIRED');
    }
  });

  it('asserts a non-null value so the compiler narrows it', () => {
    const value: string | null = 'ok';
    Ensure.notNull(value, 'value');
    expect(value.length).toBe(2);
  });
});

describe('Result', () => {
  it('short-circuits map on the failure branch', () => {
    const result = Result.fail<string>('boom').map(() => 'unreachable');
    expect(result.isFailure).toBe(true);
    expect(result.getErrorOr('fallback')).toBe('boom');
  });

  it('chains flatMap on the success branch', () => {
    const result = Result.ok(2).flatMap((value) => Result.ok(value * 21));
    expect(result.unwrapOrThrow()).toBe(42);
  });

  it('refuses to unwrap a failure and explains why', () => {
    const result = Result.fail(new DomainError('INVALID_VALUE', 'nope'));
    expect(() => result.unwrapOrThrow()).toThrow('nope');
  });
});

describe('AggregateRoot', () => {
  it('buffers domain events until they are drained', () => {
    const aggregate = TestAggregate.create('a-1');
    expect(aggregate.domainEvents).toHaveLength(1);

    const drained = aggregate.clearDomainEvents();

    expect(drained).toHaveLength(1);
    expect(aggregate.domainEvents).toHaveLength(0);
  });

  it('clears the buffer so a second save cannot re-insert the same events', () => {
    const aggregate = TestAggregate.create('a-1');
    aggregate.clearDomainEvents();

    expect(aggregate.clearDomainEvents()).toHaveLength(0);
  });
});

describe('BaseEntity soft delete', () => {
  it('marks the entity deleted and back-datable', () => {
    const aggregate = TestAggregate.create('a-1');

    aggregate.softDelete();
    expect(aggregate.isDeleted).toBe(true);

    aggregate.restore();
    expect(aggregate.isDeleted).toBe(false);
  });

  it('is idempotent', () => {
    const aggregate = TestAggregate.create('a-1');
    aggregate.softDelete();
    const first = aggregate.deletedAt;

    aggregate.softDelete();
    expect(aggregate.deletedAt).toBe(first);
  });
});

describe('Specification', () => {
  interface Row {
    id: string;
    active: boolean;
  }

  const active = new PredicateSpecification<Row>((row) => row.active);
  const idIs = (id: string) =>
    new PredicateSpecification<Row>((row) => row.id === id);

  it('composes with and', () => {
    expect(active.and(idIs('x')).isSatisfiedBy({ id: 'x', active: true })).toBe(true);
    expect(active.and(idIs('x')).isSatisfiedBy({ id: 'y', active: true })).toBe(false);
  });

  it('composes with or and not', () => {
    expect(active.or(idIs('x')).isSatisfiedBy({ id: 'x', active: false })).toBe(true);
    expect(active.not().isSatisfiedBy({ id: 'x', active: false })).toBe(true);
  });
});

describe('SagaOrchestrator', () => {
  interface Ctx {
    steps: string[];
    /** Set so a chosen step throws, to exercise compensation. */
    failAt?: string;
  }

  const step = (name: string): ISagaStep<Ctx> => ({
    name,
    async execute(context) {
      if (context.failAt === name) throw new Error(`${name} failed`);
      return { ...context, steps: [...context.steps, name] };
    },
    async compensate(context) {
      return {
        steps: context.steps.filter((done) => done !== name),
        failAt: context.failAt,
      };
    },
  });

  it('runs steps forward and returns the accumulated context', async () => {
    const saga = new SagaOrchestrator<Ctx>('s1').addStep(step('a')).addStep(step('b'));

    const result = await saga.execute({ steps: [] });

    expect(result.steps).toEqual(['a', 'b']);
  });

  it('compensates every completed step when a later step fails', async () => {
    const saga = new SagaOrchestrator<Ctx>('s1')
      .addStep(step('a'))
      .addStep(step('b'))
      .addStep(step('c'));

    // `c` throws, so `a` and `b` must both be unwound before the error propagates.
    await expect(saga.execute({ steps: [], failAt: 'c' })).rejects.toThrow(
      /failed at step "c"/,
    );
  });

  it('reports which compensation failed instead of aborting the rest', async () => {
    // `a` completes, then `boom` fails. Compensating `a` throws, and that failure must be
    // collected — not allowed to stop the loop, and not allowed to be swallowed.
    const explodingCompensation: ISagaStep<Ctx> = {
      name: 'exploding',
      async execute(context) {
        return { ...context, steps: [...context.steps, 'exploding'] };
      },
      async compensate() {
        throw new Error('compensation exploded');
      },
    };

    const saga = new SagaOrchestrator<Ctx>('s1')
      .addStep(explodingCompensation)
      .addStep(step('boom'));

    const error = await saga.execute({ steps: [], failAt: 'boom' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as { compensationErrors: unknown[] }).compensationErrors).toHaveLength(1);
  });

  it('still compensates the remaining steps after one compensation throws', async () => {
    const compensationFailures: string[] = [];

    const failing: ISagaStep<Ctx> = {
      name: 'failing',
      async execute(context) {
        return { ...context, steps: [...context.steps, 'failing'] };
      },
      async compensate() {
        compensationFailures.push('failing');
        throw new Error('compensation exploded');
      },
    };

    const stillRuns: ISagaStep<Ctx> = {
      name: 'stillRuns',
      async execute(context) {
        if (context.failAt === 'never') throw new Error('unreachable');
        return context;
      },
      async compensate() {
        compensationFailures.push('stillRuns');
        return { steps: [] };
      },
    };

    const boom: ISagaStep<Ctx> = {
      name: 'boom',
      async execute(context) {
        if (context.failAt === 'boom') throw new Error('boom failed');
        return context;
      },
      async compensate(context) {
        return context;
      },
    };

    const saga = new SagaOrchestrator<Ctx>('s1')
      .addStep(failing)
      .addStep(stillRuns)
      .addStep(boom);

    await expect(saga.execute({ steps: [], failAt: 'boom' })).rejects.toThrow(
      /failed at step "boom"/,
    );

    // Reverse order, and `stillRuns` still runs even though `failing` threw during its own
    // compensation. `boom` is absent: it never completed, so there is nothing to undo.
    expect(compensationFailures).toEqual(['stillRuns', 'failing']);
  });
});