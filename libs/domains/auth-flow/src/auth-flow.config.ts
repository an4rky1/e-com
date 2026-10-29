/**
 * @fileoverview The `GATEWAY_*` namespace.
 *
 * @remarks `process.env` appears in exactly one function of this library. Everything else
 * takes a resolved {@link AuthFlowConfig}, which is what lets a suite build a policy — a
 * one-second flow, an attempt budget of 1 — without mutating global state.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a service that
 * could point itself at another database would make "one service, one database" enforceable
 * only by convention.
 */
import { z } from 'zod';
import { envInt, envString, readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';

/** This service's own Prisma client. Never shared with another domain lib. */
export const AUTH_FLOW_PRISMA = Symbol('AUTH_FLOW_PRISMA');

/** The resolved namespace, injected everywhere instead of a module-level read. */
export const AUTH_FLOW_CONFIG = Symbol('AUTH_FLOW_CONFIG');

export const Defaults = {
  /**
   * How long an unanswered flow stays open.
   *
   * @remarks Five minutes: long enough to find an authenticator app and type a code, short
   * enough that an abandoned browser tab is not a credential sitting in a table.
   */
  FLOW_TTL_SEC: 300,
  /** How many times one flow row may be advanced before it fails for good. */
  MAX_ATTEMPTS: 5,
  /** Absolute deadline on one outbound gRPC call. */
  GRPC_DEADLINE_MS: 3_000,
  IDENTITY_URL: 'localhost:5001',
  CREDENTIAL_VAULT_URL: 'localhost:5002',
  MFA_URL: 'localhost:5003',
  SESSION_URL: 'localhost:5004',
} as const;

export const authFlowSchema = z.object({
  FLOW_TTL_SEC: envInt(Defaults.FLOW_TTL_SEC, { min: 30, max: 3_600 }),
  MAX_ATTEMPTS: envInt(Defaults.MAX_ATTEMPTS, { min: 1, max: 20 }),
  GRPC_DEADLINE_MS: envInt(Defaults.GRPC_DEADLINE_MS, { min: 100, max: 30_000 }),
  IDENTITY_URL: envString(Defaults.IDENTITY_URL),
  CREDENTIAL_VAULT_URL: envString(Defaults.CREDENTIAL_VAULT_URL),
  MFA_URL: envString(Defaults.MFA_URL),
  SESSION_URL: envString(Defaults.SESSION_URL),
});

export type AuthFlowEnvConfig = z.infer<typeof authFlowSchema>;

export interface AuthFlowConfig {
  /** The lifetime of one flow, in milliseconds. Handed to `AuthFlow.start` as policy. */
  readonly flowTtlMs: number;
  readonly maxAttempts: number;
  readonly grpcDeadlineMs: number;
  readonly identityUrl: string;
  readonly credentialVaultUrl: string;
  readonly mfaUrl: string;
  readonly sessionUrl: string;
}

/**
 * Reads `GATEWAY_*` into a validated config.
 *
 * @remarks `env` is a parameter so a test never reaches into `process.env`, and so the same
 * resolver serves the boot path and a fixture.
 */
export function resolveAuthFlowConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthFlowConfig {
  const parsed = readNamespacedEnv('GATEWAY', authFlowSchema, env);

  return resolveModuleConfig<AuthFlowConfig>(
    {
      flowTtlMs: parsed.FLOW_TTL_SEC * 1_000,
      maxAttempts: parsed.MAX_ATTEMPTS,
      grpcDeadlineMs: parsed.GRPC_DEADLINE_MS,
      identityUrl: parsed.IDENTITY_URL,
      credentialVaultUrl: parsed.CREDENTIAL_VAULT_URL,
      mfaUrl: parsed.MFA_URL,
      sessionUrl: parsed.SESSION_URL,
    },
    {},
  );
}