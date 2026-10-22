/**
 * @fileoverview The permission decision engine.
 *
 * @remarks Pure by construction: no repository, no clock, no configuration, no `Result` and
 * no I/O. Everything it needs arrives in one argument and everything it produces is derived
 * from that argument. That is not stylistic — an authorisation decision is the one piece of
 * logic that must be provable by a unit test rather than by a staging environment, and a
 * function that touches a database cannot be.
 */

import {
  DENYING_EFFECTS,
  PolicyEffect,
} from './value-objects/policy-effect.vo';
import {
  RESOURCE_TYPE_ATTRIBUTE,
  conditionsHold,
} from './value-objects/policy-condition.vo';
import type {
  EvaluationContext,
  PolicyCondition,
} from './value-objects/policy-condition.vo';

/** A role as the evaluator sees it: a name and the permissions it declares. */
export interface EvaluableRole {
  readonly name: string;
  readonly permissions: readonly string[];
}

/** A policy as the evaluator sees it: the rule fields, flattened. */
export interface EvaluablePolicy {
  readonly id: string;
  readonly role: string;
  readonly permission: string;
  readonly effect: PolicyEffect;
  readonly conditions: readonly PolicyCondition[];
  readonly priority: number;
  readonly resourceType: string | null;
}

export interface PermissionEvaluation {
  readonly userId: string;
  readonly roles: readonly EvaluableRole[];
  readonly policies: readonly EvaluablePolicy[];
  readonly permission: string;
  readonly context?: EvaluationContext;
}

/**
 * The verdict, plus why.
 *
 * @remarks `reason` is for operators and audit records. It is deliberately never rendered to
 * an end user: "denied by policy p-42 because your tenant is not eu" tells an attacker
 * exactly which rule to go and satisfy next.
 */
export interface PermissionDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** Set when a policy decided the outcome; absent for a plain RBAC decision. */
  readonly matchedPolicyId?: string;
}

export class PermissionEvaluator {
  /**
   * Answers "may this user do this?".
   *
   * @remarks Precedence, highest first:
   *
   * 1. **A matching deny wins, unconditionally.** Not the highest priority, not the most
   *    specific — any matching deny beats any matching allow. This is the single most
   *    important rule in the whole service. A permissive default means an operator who adds
   *    an allow can silently re-open something a deny was written to close, and a
   *    priority-ordered comparison means two rules written by two people can disagree about
   *    which wins, which is exactly the situation a deny exists to survive.
   * 2. **A matching allow wins.**
   * 3. **Otherwise, plain RBAC**: any role the user holds that declares the permission.
   *
   * RBAC is last because it is the least specific statement: it says nothing about the
   * context, so it must not be able to overrule something that does.
   */
  static evaluate(input: PermissionEvaluation): PermissionDecision {
    const context = input.context ?? {};
    const roleNames = new Set(input.roles.map((role) => role.name));

    const matching = input.policies
      // Policies of roles the user does not hold are not evidence about this user, so they
      // cannot either grant or deny.
      .filter((policy) => roleNames.has(policy.role))
      .filter((policy) => matchesPolicy(policy, input.permission, context))
      // Highest priority first, so the cited rule is the one an operator most likely meant.
      .sort(byPriorityDescending);

    const deny = matching.find((policy) => DENYING_EFFECTS.has(policy.effect));
    if (deny) {
      return {
        allowed: false,
        reason: `denied by policy ${deny.id} on role ${deny.role}`,
        matchedPolicyId: deny.id,
      };
    }

    const allow = matching.find((policy) => policy.effect === PolicyEffect.ALLOW);
    if (allow) {
      return {
        allowed: true,
        reason: `allowed by policy ${allow.id} on role ${allow.role}`,
        matchedPolicyId: allow.id,
      };
    }

    const role = input.roles.find((candidate) =>
      candidate.permissions.includes(input.permission),
    );
    if (role) {
      return { allowed: true, reason: `role ${role.name} grants the permission` };
    }

    return {
      allowed: false,
      reason:
        input.roles.length === 0
          ? 'the user holds no role that grants the permission'
          : 'no held role grants the permission',
    };
  }

  /**
   * The permissions the user's roles confer, ignoring context.
   *
   * @remarks This is what goes into an access token and what `GetPermissions` returns. It is
   * deliberately *not* the result of evaluating every permission: a token claim has to be a
   * flat list the resource server can check without a round trip, so ABAC rules are
   * evaluated at the boundary with {@link evaluate} and never baked into the token.
   */
  static effectivePermissions(roles: readonly EvaluableRole[]): string[] {
    const unique = new Set<string>();
    for (const role of roles) {
      for (const permission of role.permissions) {
        unique.add(permission);
      }
    }
    return [...unique].sort();
  }
}

/** Permission, resource type and every condition must hold — an AND, never an OR. */
function matchesPolicy(
  policy: EvaluablePolicy,
  permission: string,
  context: EvaluationContext,
): boolean {
  if (policy.permission !== permission) return false;

  if (
    policy.resourceType !== null &&
    context[RESOURCE_TYPE_ATTRIBUTE] !== policy.resourceType
  ) {
    return false;
  }

  // Delegated rather than re-implemented: the aggregate's `matches()` uses the same
  // predicate, and two definitions of "the context satisfies this rule" is how a deny rule
  // ends up firing in one call path and not in another.
  return conditionsHold(policy.conditions ?? [], context);
}

function byPriorityDescending(a: EvaluablePolicy, b: EvaluablePolicy): number {
  return b.priority - a.priority;
}