/**
 * @fileoverview The effect an ABAC policy carries.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the wire format is plain text. The database
 * column is `text` for the same reason — adding an effect must not be a migration.
 */

export const PolicyEffect = {
  ALLOW: 'allow',
  DENY: 'deny',
} as const;

export type PolicyEffect = (typeof PolicyEffect)[keyof typeof PolicyEffect];

/**
 * Effects that can only ever remove access.
 *
 * @remarks Exposed as a set rather than a comparison so that a new effect added later fails
 * to compile in the evaluator rather than silently falling through the deny branch.
 */
export const DENYING_EFFECTS: ReadonlySet<PolicyEffect> = new Set([PolicyEffect.DENY]);

export function isPolicyEffect(value: unknown): value is PolicyEffect {
  return (
    typeof value === 'string' &&
    (Object.values(PolicyEffect) as string[]).includes(value)
  );
}