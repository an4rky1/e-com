/**
 * @fileoverview What an issued key is allowed to do.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the wire format is plain text. The `scopes`
 * column is a `text[]` for the same reason — adding a scope must not be a migration.
 *
 * @remarks The vocabulary is deliberately tiny. A key is a machine credential: it either
 * reads, writes, deletes, or holds the lot. Anything finer-grained would end up encoding
 * business rules in a string that no test can hold stable.
 */

import { DomainError } from '@auth/ddd-core';

export const ApiKeyScope = {
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
  /** Super-scope: satisfies every other requirement. See {@link satisfiesScopes}. */
  ADMIN: 'admin',
} as const;

export type ApiKeyScope = (typeof ApiKeyScope)[keyof typeof ApiKeyScope];

/** Every scope, in increasing order of authority. Used to validate input and to document the API. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  ApiKeyScope.READ,
  ApiKeyScope.WRITE,
  ApiKeyScope.DELETE,
  ApiKeyScope.ADMIN,
];

/**
 * The scope that stands in for all the others.
 *
 * @remarks Named as a constant rather than read out of {@link ApiKeyScope} at the use site:
 * "admin is the super-scope" is a rule, and a rule that is re-typed at every comparison is a
 * rule that one day disagrees with itself.
 */
export const SUPER_SCOPE: ApiKeyScope = ApiKeyScope.ADMIN;

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return (
    typeof value === 'string' &&
    (Object.values(ApiKeyScope) as string[]).includes(value)
  );
}

/**
 * Whether a held set of scopes covers a required set.
 *
 * @remarks Every requirement must be met: "may do A **and** B" is what administrative routes
 * actually mean, and a check that passed when only one of several requirements was satisfied
 * would eventually be applied to a route where that is exactly the wrong answer.
 *
 * @remarks {@link SUPER_SCOPE} short-circuits the whole comparison. That is the one place in
 * the platform where holding more access satisfies a requirement it does not literally carry,
 * so it is stated once, here, rather than left to each caller to remember.
 *
 * @remarks An empty requirement is satisfied by anything — including nothing at all. It is
 * the honest answer for a route that declares no scope constraint, and the guard never calls
 * it in that case.
 */
export function satisfiesScopes(
  held: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[],
): boolean {
  if (required.length === 0) return true;
  if (held.includes(SUPER_SCOPE)) return true;
  return required.every((scope) => held.includes(scope));
}

/**
 * Canonicalises a requested scope list.
 *
 * @remarks De-duplicated and ordered, so `['read','read']` and `['read']` cannot become two
 * distinguishable keys: the `(user_id, name)` unique index is the only thing stopping a
 * second key with the same name, and the stored row must not depend on how the caller ordered
 * its array. Unknown entries are rejected rather than dropped — silently issuing a key with
 * fewer rights than were asked for is how a client believes it is authorised and is not.
 */
export function normaliseScopes(
  input: readonly string[] | undefined,
): ApiKeyScope[] {
  if (!input || input.length === 0) return [];

  const seen = new Set<ApiKeyScope>();
  for (const candidate of input) {
    if (!isApiKeyScope(candidate)) {
      throw new DomainError(
        'INVALID_VALUE',
        `"${String(candidate)}" is not an api key scope`,
        { expected: [...API_KEY_SCOPES] },
      );
    }
    seen.add(candidate);
  }

  return API_KEY_SCOPES.filter((scope) => seen.has(scope));
}

/**
 * Keeps only the scopes this build understands.
 *
 * @remarks For rows, not requests. The column is a `text[]`, so a service that has since been
 * extended can leave a value behind that an older build meets on a plain `SELECT *`; throwing
 * there would turn a routine rollout into an outage. Dropping an unknown scope is the safe
 * direction — it can only ever remove authority, never grant it.
 */
export function sanitiseScopes(input: readonly string[] | undefined): ApiKeyScope[] {
  return API_KEY_SCOPES.filter((scope) => input?.includes(scope) === true);
}