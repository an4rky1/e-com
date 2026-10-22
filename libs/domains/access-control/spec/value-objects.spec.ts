import {
  MAX_PERMISSION_SLUG_LENGTH,
  PERMISSION_SLUG_PATTERN,
  PermissionSlug,
} from '../src/domain/value-objects/permission-slug.vo';
import {
  MAX_ROLE_NAME_LENGTH,
  RoleName,
} from '../src/domain/value-objects/role-name.vo';

describe('PermissionSlug', () => {
  it('accepts the canonical resource:action form and splits it', () => {
    const slug = PermissionSlug.create('users:write');

    expect(slug.isSuccess).toBe(true);
    expect(slug.unwrapOrThrow().resource).toBe('users');
    expect(slug.unwrapOrThrow().action).toBe('write');
    expect(slug.unwrapOrThrow().value).toBe('users:write');
  });

  it('accepts a dotted action, e.g. billing:invoice.read', () => {
    expect(PermissionSlug.isValid('billing:invoice.read')).toBe(true);
  });

  it('rejects a slug with no action — the half-written form that matches everything by accident', () => {
    expect(PermissionSlug.create('users:').isFailure).toBe(true);
    expect(PermissionSlug.create('users').isFailure).toBe(true);
  });

  it('rejects a slug with no resource', () => {
    expect(PermissionSlug.create(':write').isFailure).toBe(true);
  });

  it('rejects more than one separator', () => {
    // `users:write:all` is ambiguous: is the resource `users` and the action `write:all`, or
    // two actions? Nothing should have to guess.
    expect(PermissionSlug.create('users:write:all').isFailure).toBe(true);
  });

  it('rejects spaces and empty strings', () => {
    for (const malformed of ['users: write', 'users :write', '  ', '']) {
      expect(PermissionSlug.create(malformed).isFailure).toBe(true);
    }
  });

  it('normalises case instead of rejecting it, so two spellings cannot become two permissions', () => {
    // `Users:Write` and `users:write` must be one permission: a role that declares the second
    // would otherwise silently not grant what an operator believes it does.
    expect(PermissionSlug.fromTrusted('Users:Write').value).toBe('users:write');
  });

  it('rejects a non-string', () => {
    expect(PermissionSlug.isValid(42)).toBe(false);
    expect(PermissionSlug.isValid(null)).toBe(false);
    expect(PermissionSlug.isValid({ value: 'users:write' })).toBe(false);
  });

  it('rejects a slug beyond the length bound', () => {
    const tooLong = `users:${'a'.repeat(MAX_PERMISSION_SLUG_LENGTH)}`;
    expect(PermissionSlug.create(tooLong).isFailure).toBe(true);
  });

  it('normalises case and surrounding whitespace so two spellings cannot become two permissions', () => {
    expect(PermissionSlug.fromTrusted('  Users:Write ').value).toBe('users:write');
  });

  it('compares by value, not by instance', () => {
    const a = PermissionSlug.fromTrusted('users:write');
    const b = PermissionSlug.fromTrusted('users:write');

    expect(a.equals(b)).toBe(true);
    expect(a.equals(PermissionSlug.fromTrusted('users:read'))).toBe(false);
  });

  it('throws from the trusted constructor, which is what rehydration uses', () => {
    expect(() => PermissionSlug.fromTrusted('nonsense')).toThrow();
  });

  it('exposes the pattern so a DTO can validate without duplicating the rule', () => {
    expect(PERMISSION_SLUG_PATTERN.test('users:write')).toBe(true);
    expect(PERMISSION_SLUG_PATTERN.test('Users:Write')).toBe(false);
  });
});

describe('RoleName', () => {
  it('accepts lower_snake_case and normalises to it', () => {
    expect(RoleName.fromTrusted(' Support_Agent ').value).toBe('support_agent');
  });

  it('rejects a name that cannot be a role', () => {
    for (const malformed of ['', 'a', 'support agent', 'support-agent', '2fa']) {
      expect(RoleName.create(malformed).isFailure).toBe(true);
    }
  });

  it('rejects a name beyond the length bound', () => {
    expect(RoleName.create('r'.repeat(MAX_ROLE_NAME_LENGTH + 1)).isFailure).toBe(true);
  });

  it('refuses a non-string', () => {
    expect(RoleName.isValid(7)).toBe(false);
  });
});