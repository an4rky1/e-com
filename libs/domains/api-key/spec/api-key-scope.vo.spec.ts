/**
 * @fileoverview The scope vocabulary, and the one rule that is not containment.
 *
 * @remarks `admin` is the only place in the platform where holding more access satisfies a
 * requirement a key does not literally carry. Everything else — every guard, every route, every
 * future service that reads this file — gets that behaviour from one function, which is the only
 * reason it can be trusted.
 */

import 'reflect-metadata';
import { DomainError } from '@auth/ddd-core';
import {
  API_KEY_SCOPES,
  ApiKeyScope,
  SUPER_SCOPE,
  isApiKeyScope,
  normaliseScopes,
  sanitiseScopes,
  satisfiesScopes,
} from '../src/domain/value-objects/api-key-scope.vo';
import { thrown } from './support/helpers';

describe('the scope vocabulary', () => {
  it('is read, write, delete and admin — and nothing else', () => {
    // Deliberately tiny. A key is a machine credential; finer-grained business rules belong in
    // the service that understands them, not in a string no test can hold stable.
    expect(API_KEY_SCOPES).toEqual(['read', 'write', 'delete', 'admin']);
    expect(Object.values(ApiKeyScope).sort()).toEqual(['admin', 'delete', 'read', 'write']);
  });

  it('recognises its own members and nothing adjacent', () => {
    expect(isApiKeyScope('read')).toBe(true);
    expect(isApiKeyScope('admin')).toBe(true);
    expect(isApiKeyScope('READ')).toBe(false);
    expect(isApiKeyScope('')).toBe(false);
    expect(isApiKeyScope(undefined)).toBe(false);
    expect(isApiKeyScope(['read'])).toBe(false);
  });
});

describe('satisfiesScopes — admin is a super-scope', () => {
  it('satisfies every single scope, including one it does not carry', () => {
    const admin: ApiKeyScope[] = [ApiKeyScope.ADMIN];

    expect(satisfiesScopes(admin, [ApiKeyScope.READ])).toBe(true);
    expect(satisfiesScopes(admin, [ApiKeyScope.WRITE])).toBe(true);
    expect(satisfiesScopes(admin, [ApiKeyScope.DELETE])).toBe(true);
    expect(satisfiesScopes(admin, [ApiKeyScope.ADMIN])).toBe(true);
  });

  it('satisfies every combination of requirements, held or not', () => {
    const admin: ApiKeyScope[] = [ApiKeyScope.ADMIN];

    for (const required of [
      [],
      [ApiKeyScope.READ],
      [ApiKeyScope.WRITE, ApiKeyScope.DELETE],
      [ApiKeyScope.READ, ApiKeyScope.WRITE, ApiKeyScope.DELETE],
      [ApiKeyScope.READ, ApiKeyScope.WRITE, ApiKeyScope.DELETE, ApiKeyScope.ADMIN],
    ]) {
      expect(satisfiesScopes(admin, required)).toBe(true);
    }
  });

  it('satisfies a requirement on its own, rather than only alongside `admin`', () => {
    // The trap this rule invites: writing `held.includes(SUPER_SCOPE) && required.includes(SUPER_SCOPE)`.
    // `admin` is *stronger* than every other scope, so it must pass a check it does not appear in.
    expect(satisfiesScopes([ApiKeyScope.ADMIN], [ApiKeyScope.DELETE])).toBe(true);
    expect(satisfiesScopes([ApiKeyScope.ADMIN, ApiKeyScope.READ], [ApiKeyScope.WRITE])).toBe(true);
  });
});

describe('satisfiesScopes — everything else is containment', () => {
  it('does not let `read` satisfy `write`', () => {
    // The pair the requirement calls out, and the one an authorisation bug always takes the
    // shape of: a read-only integration key reaching a write route.
    expect(satisfiesScopes([ApiKeyScope.READ], [ApiKeyScope.WRITE])).toBe(false);
    expect(satisfiesScopes([ApiKeyScope.READ], [ApiKeyScope.DELETE])).toBe(false);
    expect(satisfiesScopes([ApiKeyScope.READ], [ApiKeyScope.ADMIN])).toBe(false);
  });

  it('requires *every* listed scope, not any of them', () => {
    // "May do A **and** B" is what an administrative route actually means. A check that passed
    // when only one requirement was met would be applied one day to a route where that is
    // exactly the wrong answer.
    expect(satisfiesScopes([ApiKeyScope.READ, ApiKeyScope.WRITE], [ApiKeyScope.READ, ApiKeyScope.DELETE])).toBe(false);
    expect(satisfiesScopes([ApiKeyScope.READ, ApiKeyScope.DELETE], [ApiKeyScope.READ, ApiKeyScope.DELETE])).toBe(true);
  });

  it('refuses a key that carries nothing at all', () => {
    expect(satisfiesScopes([], [ApiKeyScope.READ])).toBe(false);
    expect(satisfiesScopes([], [])).toBe(true);
  });

  it('answers yes for an empty requirement, whatever is held', () => {
    // The honest answer for a route that declares no constraint: the guard never calls it in
    // that case, and an authenticated key is enough.
    expect(satisfiesScopes([ApiKeyScope.READ], [])).toBe(true);
    expect(SUPER_SCOPE).toBe(ApiKeyScope.ADMIN);
  });
});

describe('normaliseScopes', () => {
  it('de-duplicates and orders, so two spellings of the same key are one key', () => {
    expect(normaliseScopes(['write', 'read', 'write'])).toEqual(['read', 'write']);
    expect(normaliseScopes(['admin'])).toEqual(['admin']);
    expect(normaliseScopes([])).toEqual([]);
    expect(normaliseScopes(undefined)).toEqual([]);
  });

  it('refuses a scope it does not know rather than dropping it', () => {
    // Dropping it would issue a key with fewer rights than were asked for, and the client would
    // believe it is authorised when it is not.
    const error = thrown(() => normaliseScopes(['read', 'superuser'])) as DomainError;

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('INVALID_VALUE');
  });
});

describe('sanitiseScopes', () => {
  it('keeps only the scopes this build understands', () => {
    // For rows, not requests. A value written by a newer build must not turn a routine rollout
    // into an outage of the whole service — and dropping an unknown scope can only ever remove
    // authority, never grant it.
    expect(sanitiseScopes(['read', 'superuser', 'admin'])).toEqual(['read', 'admin']);
    expect(sanitiseScopes(['superuser'])).toEqual([]);
    expect(sanitiseScopes(undefined)).toEqual([]);
  });
});