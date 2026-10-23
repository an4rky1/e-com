import { AggregateRoot, DomainEvent, EntityId, Ensure, type IDomainEvent } from '@auth/core';
import { PermissionSlug } from './value-objects/permission-slug.vo';
import { PolicyEffect, isPolicyEffect } from './value-objects/policy-effect.vo';
import {
  RESOURCE_TYPE_ATTRIBUTE,
  conditionsHold,
  isConditionOperator,
  type EvaluationContext,
  type PolicyCondition,
} from './value-objects/policy-condition.vo';
import { RoleName } from './value-objects/role-name.vo';

/** Aggregate/event identity constants — the prefix that scopes every policy event. */
export const POLICY_AGGREGATE = 'Policy';

export class PolicyCreated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      policyId: string;
      role: string;
      permission: string;
      effect: PolicyEffect;
      priority: number;
    },
    version = 1,
  ) {
    super(aggregateId, POLICY_AGGREGATE, 'policy.created', version);
  }
}

export class PolicyDeleted extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      policyId: string;
      role: string;
      permission: string;
      reason: string | null;
    },
    version = 1,
  ) {
    super(aggregateId, POLICY_AGGREGATE, 'policy.deleted', version);
  }
}

export interface PolicyProps {
  role: RoleName;
  permission: PermissionSlug;
  effect: PolicyEffect;
  conditions: readonly PolicyCondition[];
  /** Higher wins when two matching rules disagree on which one to cite in the audit. */
  priority: number;
  resourceType: string | null;
  description: string | null;
  version: number;
}

/**
 * One ABAC rule: *this role, doing this action, on this kind of resource, in this context,
 * is allowed (or denied)*.
 *
 * @remarks A policy belongs to exactly one role. Attaching a rule to a user instead would
 * mean an authorisation decision that no one can answer by reading a role definition, which
 * is the failure mode that makes access control unmaintainable.
 */
export class Policy extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: PolicyProps,
    createdAt: Date,
  ) {
    super(id, createdAt, createdAt);
  }

  static create(input: {
    role: string | RoleName;
    permission: string | PermissionSlug;
    effect: PolicyEffect | string;
    conditions?: readonly PolicyCondition[];
    priority?: number;
    resourceType?: string | null;
    description?: string | null;
    now?: Date;
    id?: string;
  }): Policy {
    const role =
      input.role instanceof RoleName ? input.role : RoleName.fromTrusted(input.role);
    const permission =
      input.permission instanceof PermissionSlug
        ? input.permission
        : PermissionSlug.fromTrusted(input.permission);

    // An unrecognised effect is rejected rather than defaulted: defaulting to `allow` would
    // turn a typo into a grant and defaulting to `deny` would silently disable a rule
    // somebody believes is in force.
    Ensure.isTrue(
      isPolicyEffect(input.effect),
      `policy effect must be one of ${Object.values(PolicyEffect).join(', ')}`,
      'INVALID_VALUE',
    );

    const priority = input.priority ?? 0;
    Ensure.inRange(priority, -1_000, 1_000, 'priority');

    const id = input.id ?? EntityId.create();
    const now = input.now ?? new Date();

    const policy = new Policy(
      id,
      {
        role,
        permission,
        effect: input.effect as PolicyEffect,
        conditions: normaliseConditions(input.conditions),
        priority,
        resourceType: input.resourceType?.trim() || null,
        description: input.description?.trim() || null,
        version: 1,
      },
      now,
    );

    policy.addDomainEvent(
      new PolicyCreated(id, {
        policyId: id,
        role: policy.props.role.value,
        permission: policy.props.permission.value,
        effect: policy.props.effect,
        priority: policy.props.priority,
      }),
    );

    return policy;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: {
    id: string;
    role: string;
    permission: string;
    effect: string;
    conditions: unknown;
    priority: number;
    resource_type: string | null;
    description: string | null;
    created_at: Date;
  }): Policy {
    return new Policy(
      row.id,
      {
        role: RoleName.fromTrusted(row.role),
        permission: PermissionSlug.fromTrusted(row.permission),
        effect: row.effect as PolicyEffect,
        conditions: normaliseConditions(readConditions(row.conditions)),
        priority: row.priority,
        resourceType: row.resource_type,
        description: row.description,
        version: 1,
      },
      row.created_at,
    );
  }

  get role(): RoleName {
    return this.props.role;
  }

  get permission(): PermissionSlug {
    return this.props.permission;
  }

  get effect(): PolicyEffect {
    return this.props.effect;
  }

  get conditions(): readonly PolicyCondition[] {
    return this.props.conditions;
  }

  get priority(): number {
    return this.props.priority;
  }

  get resourceType(): string | null {
    return this.props.resourceType;
  }

  get description(): string | null {
    return this.props.description;
  }

  get isDeny(): boolean {
    return this.props.effect === PolicyEffect.DENY;
  }

  /** Aggregated revision, independent of how many events this instance has buffered. */
  get revision(): number {
    return this.props.version;
  }

  /**
   * Whether this rule applies to the requested permission in the given context.
   *
   * @remarks Pure and synchronous: it reads nothing but its arguments, which is what makes
   * the deny/allow precedence in {@link PermissionEvaluator} testable without a database.
   */
  matches(
    permission: string,
    context: EvaluationContext = {},
  ): boolean {
    if (this.props.permission.value !== permission) return false;
    if (!this.resourceApplies(context)) return false;
    return conditionsHold(this.props.conditions, context);
  }

  /**
   * A resource-scoped rule only applies to the resource type it names.
   *
   * @remarks A caller that does not say what it is acting on has not satisfied a scoped
   * rule — including a deny rule, which is the conservative choice for allows (a broad
   * allow cannot widen past a narrow deny) and is why deny rules should not be
   * resource-scoped unless they are meant to be bypassable.
   */
  private resourceApplies(context: EvaluationContext): boolean {
    if (this.props.resourceType === null) return true;
    return context[RESOURCE_TYPE_ATTRIBUTE] === this.props.resourceType;
  }

  /**
   * Deletes the rule.
   *
   * @remarks The reason is carried on the event rather than in a column: `policies` has no
   * place for it, and "why was this deny removed" is exactly the question an incident review
   * asks, so it belongs where the fact is recorded.
   */
  remove(reason: string | null = null, now: Date = new Date()): void {
    if (this.isDeleted) return;

    this.softDelete(now);
    this.bump(now);
    this.addDomainEvent(
      new PolicyDeleted(this.id, {
        policyId: this.id,
        role: this.props.role.value,
        permission: this.props.permission.value,
        reason,
      }),
    );
  }

  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

/** `conditions` is a free-form JSON column, so anything can be sitting in it. */
function readConditions(raw: unknown): PolicyCondition[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is PolicyCondition =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { attribute?: unknown }).attribute === 'string' &&
      isConditionOperator((entry as { operator?: unknown }).operator),
  );
}

/** Dropping an unusable condition is safer than storing it: a rule that cannot be evaluated
 * must not be stored as though it could be. */
function normaliseConditions(
  conditions: readonly PolicyCondition[] | undefined,
): readonly PolicyCondition[] {
  return conditions ?? [];
}

export type PolicyEvent = PolicyCreated | PolicyDeleted;

export const isPolicyEvent = (event: IDomainEvent): event is PolicyEvent =>
  event.aggregateType === POLICY_AGGREGATE;