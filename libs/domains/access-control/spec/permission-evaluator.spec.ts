import { Policy, type PolicyCreated } from '../src/domain/policy.aggregate';
import { PolicyEffect } from '../src/domain/value-objects/policy-effect.vo';
import { ConditionOperator } from '../src/domain/value-objects/policy-condition.vo';
import {
  PermissionEvaluator,
  type EvaluablePolicy,
  type EvaluableRole,
} from '../src/domain/permission-evaluator';

const ROLE: EvaluableRole = {
  name: 'billing_admin',
  permissions: ['billing:invoice.write'],
};

const policy = (overrides: Partial<EvaluablePolicy> = {}): EvaluablePolicy => ({
  id: '9a1d3c2b-6e4c-4c1f-9b3a-8e1f0c7a5b21',
  role: 'billing_admin',
  permission: 'billing:invoice.write',
  effect: PolicyEffect.ALLOW,
  conditions: [],
  priority: 0,
  resourceType: null,
  ...overrides,
});

const evaluate = (
  permission: string,
  policies: readonly EvaluablePolicy[],
  roles: readonly EvaluableRole[] = [ROLE],
  context: Record<string, string> = {},
) =>
  PermissionEvaluator.evaluate({
    userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    permission,
    policies,
    roles,
    context,
  });

describe('Policy.create', () => {
  it('normalises the rule into typed fields and emits policy.created', () => {
    const created = Policy.create({
      role: 'billing_admin',
      permission: 'billing:invoice.write',
      effect: PolicyEffect.DENY,
      conditions: [
        { attribute: 'tenant', operator: ConditionOperator.NOT_EQUALS, value: 'eu' },
      ],
      priority: 10,
      resourceType: 'invoice',
      description: 'Non-EU writes need a second approver',
    });

    expect(created.isDeny).toBe(true);
    expect(created.permission.value).toBe('billing:invoice.write');
    expect(created.role.value).toBe('billing_admin');
    expect(created.conditions).toHaveLength(1);

    const [event] = created.domainEvents as PolicyCreated[];
    expect(event.eventType).toBe('policy.created');
    expect(event.payload.effect).toBe(PolicyEffect.DENY);
    expect(event.payload.priority).toBe(10);
  });

  it('refuses an effect it does not recognise rather than guessing one', () => {
    // Defaulting either way writes a rule that does not mean what the operator wrote, and a
    // deny that silently became an allow is the worst possible outcome.
    expect(() =>
      Policy.create({
        role: 'billing_admin',
        permission: 'billing:invoice.write',
        effect: 'permit',
      }),
    ).toThrow(/policy effect must be one of allow, deny/);
  });

  it('refuses a priority outside the supported band', () => {
    expect(() =>
      Policy.create({
        role: 'billing_admin',
        permission: 'billing:invoice.write',
        effect: PolicyEffect.ALLOW,
        priority: 99_999,
      }),
    ).toThrow(/priority/);
  });
});

describe('Policy.matches', () => {
  it('requires the permission to be the one asked about', () => {
    const rule = Policy.create({
      role: 'billing_admin',
      permission: 'billing:invoice.write',
      effect: PolicyEffect.ALLOW,
    });

    expect(rule.matches('billing:invoice.write')).toBe(true);
    expect(rule.matches('billing:invoice.delete')).toBe(false);
  });

  it('honours every condition', () => {
    const rule = Policy.create({
      role: 'billing_admin',
      permission: 'billing:invoice.write',
      effect: PolicyEffect.ALLOW,
      conditions: [
        { attribute: 'tenant', operator: ConditionOperator.EQUALS, value: 'eu' },
        { attribute: 'amount', operator: ConditionOperator.IN, value: ['100', '200'] },
      ],
    });

    expect(rule.matches('billing:invoice.write', { tenant: 'eu', amount: '100' })).toBe(true);
    expect(rule.matches('billing:invoice.write', { tenant: 'eu', amount: '999' })).toBe(false);
    expect(rule.matches('billing:invoice.write', { tenant: 'us', amount: '100' })).toBe(false);
  });

  it('does not fire a rule when the caller did not supply the attribute', () => {
    const rule = Policy.create({
      role: 'billing_admin',
      permission: 'billing:invoice.write',
      effect: PolicyEffect.ALLOW,
      conditions: [
        { attribute: 'tenant', operator: ConditionOperator.NOT_EQUALS, value: 'eu' },
      ],
    });

    // Absence of evidence is not evidence of absence: a missing attribute must not satisfy a
    // rule, or a caller who omits the attribute passes rules written to stop them.
    expect(rule.matches('billing:invoice.write', {})).toBe(false);
    expect(rule.matches('billing:invoice.write', { tenant: 'us' })).toBe(true);
  });

  it('scopes a rule to the resource type it names', () => {
    const rule = Policy.create({
      role: 'billing_admin',
      permission: 'billing:invoice.write',
      effect: PolicyEffect.ALLOW,
      resourceType: 'invoice',
    });

    expect(rule.matches('billing:invoice.write', { resourceType: 'invoice' })).toBe(true);
    expect(rule.matches('billing:invoice.write', { resourceType: 'refund' })).toBe(false);
    expect(rule.matches('billing:invoice.write', {})).toBe(false);
  });
});

describe('PermissionEvaluator — deny wins over allow', () => {
  it('refuses when a matching deny and a matching allow both apply', () => {
    // THE rule. An allow from one rule and a deny from another must resolve to deny, or the
    // exception stops being an exception.
    const decision = evaluate('billing:invoice.write', [
      policy({ id: 'allow-1', effect: PolicyEffect.ALLOW }),
      policy({ id: 'deny-1', effect: PolicyEffect.DENY }),
    ]);

    expect(decision.allowed).toBe(false);
    expect(decision.matchedPolicyId).toBe('deny-1');
  });

  it('lets the deny win even when the allow has far higher priority', () => {
    const decision = evaluate('billing:invoice.write', [
      policy({ id: 'deny-1', effect: PolicyEffect.DENY, priority: 1 }),
      policy({ id: 'allow-1', effect: PolicyEffect.ALLOW, priority: 1_000 }),
    ]);

    expect(decision.allowed).toBe(false);
    expect(decision.matchedPolicyId).toBe('deny-1');
  });

  it('lets the deny win over the role that declares the permission', () => {
    // RBAC is the least specific statement available, so it must not be able to overrule
    // something that considered the context.
    const decision = evaluate('billing:invoice.write', [
      policy({ id: 'deny-1', effect: PolicyEffect.DENY }),
    ]);

    expect(ROLE.permissions).toContain('billing:invoice.write');
    expect(decision.allowed).toBe(false);
  });

  it('only denies when the deny rule actually matches its conditions', () => {
    const decision = evaluate(
      'billing:invoice.write',
      [
        policy({
          id: 'deny-1',
          effect: PolicyEffect.DENY,
          conditions: [
            { attribute: 'tenant', operator: 'equals', value: 'eu' },
          ],
        }),
      ],
      [ROLE],
      { tenant: 'us' },
    );

    expect(decision.allowed).toBe(true);
  });
});

describe('PermissionEvaluator — everything else', () => {
  it('allows a matching allow policy', () => {
    const decision = evaluate('billing:invoice.write', [
      policy({ effect: PolicyEffect.ALLOW }),
    ]);

    expect(decision.allowed).toBe(true);
    expect(decision.matchedPolicyId).toBe(policy().id);
  });

  it('falls back to the role when no policy applies', () => {
    const decision = evaluate('billing:invoice.write', []);

    expect(decision.allowed).toBe(true);
    expect(decision.matchedPolicyId).toBeUndefined();
    expect(decision.reason).toMatch(/role billing_admin grants/);
  });

  it('refuses a permission no held role grants', () => {
    const decision = evaluate('billing:invoice.delete', []);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no held role grants/);
  });

  it('refuses a user with no roles at all, and says so', () => {
    const decision = evaluate('billing:invoice.write', [policy({ effect: PolicyEffect.DENY })], []);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/holds no role/);
  });

  it('ignores policies attached to roles the user does not hold', () => {
    // Otherwise revoking a role would not remove its rules — and a deny rule belonging to
    // somebody else's role would block this user forever.
    const decision = evaluate(
      'billing:invoice.write',
      [policy({ role: 'somebody_else', effect: PolicyEffect.DENY })],
      [ROLE],
    );

    expect(decision.allowed).toBe(true);
  });

  it('cites the highest-priority matching rule in the reason', () => {
    const decision = evaluate('billing:invoice.write', [
      policy({ id: 'low', effect: PolicyEffect.ALLOW, priority: 1 }),
      policy({ id: 'high', effect: PolicyEffect.ALLOW, priority: 9 }),
    ]);

    expect(decision.matchedPolicyId).toBe('high');
  });

  it('is pure — the same input twice gives the same answer and nothing is mutated', () => {
    const roles = [ROLE];
    const policies = [policy({ effect: PolicyEffect.DENY })];

    const first = evaluate('billing:invoice.write', policies, roles);
    const second = evaluate('billing:invoice.write', policies, roles);

    expect(first).toEqual(second);
    expect(roles).toHaveLength(1);
    expect(policies).toHaveLength(1);
  });
});

describe('PermissionEvaluator.effectivePermissions', () => {
  it('unions, de-duplicates and sorts so a token claim is stable', () => {
    expect(
      PermissionEvaluator.effectivePermissions([
        { name: 'b', permissions: ['tickets:write', 'users:read'] },
        { name: 'a', permissions: ['users:read', 'users:write'] },
      ]),
    ).toEqual(['tickets:write', 'users:read', 'users:write']);
  });

  it('returns nothing for a user with no roles', () => {
    expect(PermissionEvaluator.effectivePermissions([])).toEqual([]);
  });
});