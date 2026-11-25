/**
 * @fileoverview The front's own registration endpoint.
 *
 * @remarks The register page posts to `/api/register` instead of reaching through the
 * rewrite to the gateway's `POST /auth/register` because validation belongs in the process
 * that serves the form. The three fields the page collects are checked here against the same
 * numbers the gateway checks them against — `@auth/contracts/http` owns both gates' limits,
 * so a payload that can never become an account never becomes a request either, and never
 * spends the gateway's rate limit.
 *
 * @remarks This is a first gate, not a second authority: everything accepted here can still
 * be refused over there — most often by the credential vault's own policy, whose composition
 * rules live with the vault and are deliberately not duplicated here. The response is mapped
 * rather than passed through raw so the page reads one shape — `{ error }` on any failure,
 * the issued session on success — whether the refusal came from this file, from the
 * gateway's validation, from the vault's policy, or from the gateway being unreachable.
 */
import {
  ApiRoutes,
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  EMAIL_PATTERN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  apiErrorMessage,
} from '@auth/contracts/http';
import type { RegisterRequest } from '@auth/contracts/http';
import { GATEWAY_UNAVAILABLE_MESSAGE, JSON_CONTENT_TYPE } from '../../../lib/api-constants';

const GATEWAY_ADDRESS_NOT_CONFIGURED = 'The gateway address is not configured';

/** The slice of the environment this handler needs; injectable so tests never touch `process.env`. */
type Env = { GATEWAY_URL?: string | undefined };

/** What the page receives: a status and a body that is either a session or `{ error }`. */
export type RegisterOutcome = {
  readonly status: number;
  readonly body: Record<string, unknown>;
};

const GATEWAY_TIMEOUT_MS = 10_000;

const failure = (status: number, error: string): RegisterOutcome => ({
  status,
  body: { error },
});

export async function handleRegister(
  rawBody: string,
  env: Env = { GATEWAY_URL: process.env.GATEWAY_URL },
): Promise<RegisterOutcome> {
  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    return failure(400, 'The request body must be JSON');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure(400, 'The request body must be a JSON object');
  }

  const { email, password, displayName } = input as Record<string, unknown>;

  if (typeof email !== 'string' || email.length === 0) {
    return failure(400, 'email is required');
  }
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    return failure(400, 'email must be a valid address');
  }
  if (typeof password !== 'string' || password.length === 0) {
    return failure(400, 'password is required');
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return failure(
      400,
      `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return failure(
      400,
      `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  if (displayName !== undefined && typeof displayName !== 'string') {
    return failure(400, 'displayName must be a string');
  }
  if (
    typeof displayName === 'string' &&
    displayName.length > DISPLAY_NAME_MAX_LENGTH
  ) {
    return failure(
      400,
      `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
    );
  }

  const gatewayUrl = env.GATEWAY_URL;
  if (!gatewayUrl) {
    return failure(500, GATEWAY_ADDRESS_NOT_CONFIGURED);
  }
  let registerUrl: string;
  try {
    registerUrl = new URL(ApiRoutes.register.path, gatewayUrl).toString();
  } catch {
    return failure(500, GATEWAY_ADDRESS_NOT_CONFIGURED);
  }

  // Only the three validated fields cross the wire. Anything else in the request is dropped:
  // a documented endpoint is not a place to smuggle unknown fields towards a service.
  const payload: RegisterRequest = { email, password };
  if (typeof displayName === 'string') payload.displayName = displayName;

  let response: Response;
  try {
    response = await fetch(registerUrl, {
      method: ApiRoutes.register.method,
      headers: { 'Content-Type': JSON_CONTENT_TYPE },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch {
    return failure(502, GATEWAY_UNAVAILABLE_MESSAGE);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure(502, GATEWAY_UNAVAILABLE_MESSAGE);
  }

  if (!response.ok) {
    return {
      status: response.status,
      body: { error: apiErrorMessage(body, 'The gateway refused the request') },
    };
  }
  return {
    status: response.status,
    body:
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {},
  };
}

export async function POST(request: Request): Promise<Response> {
  const { status, body } = await handleRegister(await request.text());
  return Response.json(body, { status });
}
