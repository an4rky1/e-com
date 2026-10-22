/**
 * @fileoverview Attribute conditions attached to an ABAC policy.
 *
 * @remarks A role-based rule answers "may this *kind* of user do this action"; a condition
 * answers "may this user do it *right now*, in this context". The pair is what turns RBAC
 * into ABAC, and it is deliberately a flat equality/membership vocabulary rather than an
 * expression language: an evaluator that cannot be reasoned about in one sitting is one
 * whose deny rules nobody dares to change.
 */

/** Context attribute holding the type of the resource being acted on, e.g. `invoice`. */
export const RESOURCE_TYPE_ATTRIBUTE = 'resourceType';

export const ConditionOperator = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  IN: 'in',
  CONTAINS: 'contains',
} as const;

export type ConditionOperator =
  (typeof ConditionOperator)[keyof typeof ConditionOperator];

/** A single `<attribute> <operator> <value>` test. All conditions on a policy are ANDed. */
export interface PolicyCondition {
  readonly attribute: string;
  readonly operator: ConditionOperator;
  readonly value: string | readonly string[];
}

/** Attributes supplied by the caller: IP address, tenant, resource id, hour, … */
export type EvaluationContext = Readonly<Record<string, string>>;

export function isConditionOperator(value: unknown): value is ConditionOperator {
  return (
    typeof value === 'string' &&
    (Object.values(ConditionOperator) as string[]).includes(value)
  );
}

/**
 * Evaluates one condition against the caller's context.
 *
 * @remarks A missing attribute never satisfies a condition — not even a negated one. The
 * tempting alternative is to treat "attribute absent" as "attribute is not the denied
 * value", which silently turns a deny rule into an allow for every caller that simply omits
 * the attribute. Absence of evidence is not evidence of absence: a rule that cannot be
 * evaluated does not fire, and a rule that cannot fire must not be relied upon.
 */
export function conditionMatches(
  condition: PolicyCondition,
  context: EvaluationContext,
): boolean {
  const actual = context[condition.attribute];

  // The attribute was not supplied at all, so nothing can be asserted about it.
  if (actual === undefined) return false;

  switch (condition.operator) {
    case ConditionOperator.EQUALS:
      return actual === condition.value;
    case ConditionOperator.NOT_EQUALS:
      return actual !== condition.value;
    case ConditionOperator.IN:
      return (
        Array.isArray(condition.value) && condition.value.includes(actual)
      );
    case ConditionOperator.CONTAINS:
      return (
        typeof condition.value === 'string' && actual.includes(condition.value)
      );
    default:
      // An operator this build does not know cannot be trusted to fail closed.
      return false;
  }
}

/** Every condition must hold — one unsatisfied condition means the policy does not apply. */
export function conditionsHold(
  conditions: readonly PolicyCondition[],
  context: EvaluationContext,
): boolean {
  return conditions.every((condition) => conditionMatches(condition, context));
}