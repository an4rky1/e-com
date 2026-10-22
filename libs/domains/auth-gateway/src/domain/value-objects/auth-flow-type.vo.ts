/**
 * @fileoverview What kind of walk this flow is.
 *
 * @remarks A string union rather than a TypeScript `enum`: the wire format is plain text
 * (`StartFlowRequest.flow`), so an enum would force every caller to import runtime code to
 * name something that is already a word in a proto.
 *
 * @remarks The two tables at the bottom are the interesting part. Which state a flow *starts*
 * in, and whether completing it hands back a session, are properties of the flow's purpose —
 * not of the code path that happens to complete it — so they are declared once here rather
 * than re-decided in each handler.
 */
import { AuthFlowState } from './auth-flow-state.vo';

export const AuthFlowType = {
  LOGIN: 'login',
  REGISTER: 'register',
  RESET_PASSWORD: 'reset_password',
  MAGIC_LINK: 'magic_link',
  STEP_UP: 'step_up',
} as const;

export type AuthFlowType = (typeof AuthFlowType)[keyof typeof AuthFlowType];

export const AUTH_FLOW_TYPES: readonly AuthFlowType[] = Object.values(AuthFlowType);

export function isAuthFlowType(value: unknown): value is AuthFlowType {
  return typeof value === 'string' && (AUTH_FLOW_TYPES as string[]).includes(value);
}

/**
 * Where each flow begins.
 *
 * @remarks `step_up` starts in `awaiting_step_up` and nowhere else: it is the only flow whose
 * whole purpose *is* the pause. Starting it at `awaiting_credential` would ask for a password
 * the caller has already proven — and re-proving a password is not a step-up, it is a login.
 */
export const INITIAL_STATE_BY_TYPE: Readonly<Record<AuthFlowType, AuthFlowState>> = {
  [AuthFlowType.LOGIN]: AuthFlowState.AWAITING_CREDENTIAL,
  [AuthFlowType.REGISTER]: AuthFlowState.AWAITING_CREDENTIAL,
  [AuthFlowType.RESET_PASSWORD]: AuthFlowState.AWAITING_CREDENTIAL,
  [AuthFlowType.MAGIC_LINK]: AuthFlowState.AWAITING_CREDENTIAL,
  [AuthFlowType.STEP_UP]: AuthFlowState.AWAITING_STEP_UP,
};

/**
 * Flows whose completion means "this person is signed in".
 *
 * @remarks `register`, `reset_password` and `step_up` are excluded on purpose. All three
 * *prove* something, and none of them is a sign-in: a password reset hands out no session
 * because the link that completed it may have been opened by someone who forwarded the mail,
 * and a step-up must never mint a fresh session at all — the caller already has one, and
 * re-issuing on every sensitive action would silently widen the blast radius of a stolen
 * access token from "read" to "read and re-issue".
 */
export const SESSION_ISSUING_TYPES: ReadonlySet<AuthFlowType> = new Set([
  AuthFlowType.LOGIN,
  AuthFlowType.MAGIC_LINK,
]);

/** Whether completing `type` may call session-token for a fresh pair of tokens. */
export function issuesSession(type: AuthFlowType): boolean {
  return SESSION_ISSUING_TYPES.has(type);
}

/**
 * Flows that need a second factor before they can complete.
 *
 * @remarks `register` and `reset_password` are in it because both end in "we have just changed
 * what this account is trusted with", which is exactly the moment an address that may not
 * belong to the person in front of the screen must be proved.
 */
export const SECOND_FACTOR_TYPES: ReadonlySet<AuthFlowType> = new Set([
  AuthFlowType.REGISTER,
  AuthFlowType.RESET_PASSWORD,
]);