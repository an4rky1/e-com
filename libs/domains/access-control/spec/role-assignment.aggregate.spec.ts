import {
  RoleAssignment,
  type RoleGranted,
  type RoleRevoked,
} from '../src/domain/role-assignment.aggregate';

const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const grant = (overrides: Partial<Parameters<typeof RoleAssignment.grant>[0]> = {}) =>
  RoleAssignment.grant({
    userId: USER,
    role: 'support_agent',
    grantedBy: '0f9a1d3c-2b6e-4c1f-9b3a-8e1f0c7a5b21',
    ...overrides,
  });

describe('RoleAssignment.grant', () => {
  it('starts active and unexpired', () => {
    const assignment = grant();

    expect(assignment.isActiveAt()).toBe(true);
    expect(assignment.revokedAt).toBeNull();
    expect(assignment.role.value).toBe('support_agent');
  });

  it('emits exactly one role.granted event carrying the subject and the role', () => {
    const assignment = grant();

    expect(assignment.domainEvents).toHaveLength(1);

    const [event] = assignment.domainEvents as RoleGranted[];
    expect(event.eventType).toBe('role.granted');
    expect(event.aggregateType).toBe('RoleAssignment');
    expect(event.aggregateId).toBe(assignment.id);
    expect(event.payload).toMatchObject({ userId: USER, role: 'support_agent' });
  });

  it('refuses a user-less grant', () => {
    expect(() => RoleAssignment.grant({ userId: '', role: 'support_agent' })).toThrow();
  });

  it('refuses an expiry that has already passed', () => {
    // A grant that arrives with its deadline behind it is never a grant anybody wanted; it
    // is a bug that would otherwise create a row that looks live to an operator.
    expect(() =>
      grant({ expiresAt: new Date(Date.now() - 1_000) }),
    ).toThrow(/expiresAt must be in the future/);
  });

  it('accepts a future expiry and stops being active when it passes', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const assignment = grant({ expiresAt });

    expect(assignment.isActiveAt()).toBe(true);
    expect(assignment.isActiveAt(new Date(expiresAt.getTime() + 1))).toBe(false);
  });

  it('preserves an explicitly supplied id so a replay reproduces the same row', () => {
    const id = '2b6e4c1f-9b3a-8e1f-0c7a-5b21d3c2b6e4';
    expect(grant({ id }).id).toBe(id);
  });
});

describe('RoleAssignment.revoke', () => {
  it('emits role.revoked and deactivates the assignment', () => {
    const assignment = grant();
    assignment.clearDomainEvents();

    assignment.revoke('offboarded');

    expect(assignment.isActiveAt()).toBe(false);
    expect(assignment.revokedAt).toBeInstanceOf(Date);

    const [event] = assignment.domainEvents as RoleRevoked[];
    expect(event.eventType).toBe('role.revoked');
    expect(event.payload).toMatchObject({ userId: USER, role: 'support_agent' });
  });

  it('is idempotent — a double revoke must not emit a second fact', () => {
    const assignment = grant();
    assignment.revoke('first');
    assignment.clearDomainEvents();

    assignment.revoke('second');

    expect(assignment.domainEvents).toHaveLength(0);
    expect(assignment.reason).toBe('first');
  });

  it('records the reason of the first revocation only', () => {
    const assignment = grant();
    assignment.revoke('offboarded');
    assignment.revoke('forgotten');

    expect(assignment.reason).toBe('offboarded');
  });
});

describe('RoleAssignment.fromRow', () => {
  it('rehydrates without emitting events and honours the stored state', () => {
    const revokedAt = new Date();

    const assignment = RoleAssignment.fromRow({
      id: '2b6e4c1f-9b3a-8e1f-0c7a-5b21d3c2b6e4',
      user_id: USER,
      role: 'billing_admin',
      granted_by: null,
      granted_at: new Date(),
      expires_at: null,
      revoked_at: revokedAt,
    });

    expect(assignment.domainEvents).toHaveLength(0);
    expect(assignment.isActiveAt()).toBe(false);
    expect(assignment.role.value).toBe('billing_admin');
    expect(assignment.grantedBy).toBeNull();
  });
});