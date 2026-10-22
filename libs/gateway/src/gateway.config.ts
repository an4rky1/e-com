/**
 * @fileoverview The `GATEWAY_` namespace for the api-gateway.
 *
 * @remarks `process.env` appears in exactly one function of this library. Everything else
 * takes a resolved {@link GatewayConfig}, which is what lets a suite build a config — a
 * 50 ms deadline, a peer on `127.0.0.1:1` — without mutating global state.
 *
 * @remarks **There is no `DATABASE_URL` here, and that is the design.** An edge that can be
 * pointed at a connection string is an edge that can be pointed at somebody else's state. The
 * key is absent from the schema, so `readNamespacedEnv` cannot produce one even if the process
 * has one set — and the service still boots when the variable is missing, which is the test
 * that proves the edge is stateless.
 *
 * @remarks No signing key either. The gateway never decodes a token, so a secret in its
 * environment would be a secret with no use and one more place to leak it from.
 */
import { z } from 'zod';
import {
  envInt,
  envString,
  readNamespacedEnv,
  resolveModuleConfig,
} from '@auth/platform/config';

/** The resolved namespace, injected everywhere instead of a module-level read. */
export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');

export const Defaults = {
  /**
   * Absolute deadline on one outbound gRPC call.
   *
   * @remarks The edge is the only hop in front of every other service, so it is where a slow
   * dependency has to stop rather than accumulate. Three seconds is short enough that a
   * caller sees a `DEPENDENCY_UNAVAILABLE` while the request still has a browser's worth of
   * patience left.
   */
  PEER_DEADLINE_MS: 3_000,
  /**
   * Peer addresses, defaulting to the ports each service's `main.ts` binds by default.
   *
   * @remarks These are the same numbers the per-service `main.ts` files use for `GRPC_URL`,
   * so an unmodified deployment needs no gateway-specific configuration at all.
   */
  IDENTITY_URL: 'localhost:13001',
  ACCESS_CONTROL_URL: 'localhost:13002',
  CREDENTIAL_VAULT_URL: 'localhost:13003',
  SESSION_TOKEN_URL: 'localhost:13004',
  AUTH_GATEWAY_URL: 'localhost:13005',
} as const;

export const gatewaySchema = z.object({
  PEER_DEADLINE_MS: envInt(Defaults.PEER_DEADLINE_MS, { min: 100, max: 30_000 }),
  IDENTITY_URL: envString(Defaults.IDENTITY_URL),
  ACCESS_CONTROL_URL: envString(Defaults.ACCESS_CONTROL_URL),
  CREDENTIAL_VAULT_URL: envString(Defaults.CREDENTIAL_VAULT_URL),
  SESSION_TOKEN_URL: envString(Defaults.SESSION_TOKEN_URL),
  AUTH_GATEWAY_URL: envString(Defaults.AUTH_GATEWAY_URL),
});

export type GatewayEnvConfig = z.infer<typeof gatewaySchema>;

export interface GatewayConfig {
  /** Absolute deadline applied to every outbound call. */
  readonly peerDeadlineMs: number;
  readonly identityUrl: string;
  readonly accessControlUrl: string;
  readonly credentialVaultUrl: string;
  readonly sessionTokenUrl: string;
  readonly authGatewayUrl: string;
}

/** proto package -> address, which is the shape `createStaticGrpcChannel` expects. */
export function peerAddressesOf(config: GatewayConfig): Record<string, string> {
  return {
    'identity.v1': config.identityUrl,
    'access_control.v1': config.accessControlUrl,
    'credential_vault.v1': config.credentialVaultUrl,
    'session_token.v1': config.sessionTokenUrl,
    'auth_gateway.v1': config.authGatewayUrl,
  };
}

/**
 * Reads the `GATEWAY_` namespace into a validated config.
 *
 * @remarks `env` is a parameter so a test never reaches into `process.env`, and so the same
 * resolver serves the boot path and a fixture.
 */
export function resolveGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const parsed = readNamespacedEnv('GATEWAY', gatewaySchema, env);

  return resolveModuleConfig<GatewayConfig>(
    {
      peerDeadlineMs: parsed.PEER_DEADLINE_MS,
      identityUrl: parsed.IDENTITY_URL,
      accessControlUrl: parsed.ACCESS_CONTROL_URL,
      credentialVaultUrl: parsed.CREDENTIAL_VAULT_URL,
      sessionTokenUrl: parsed.SESSION_TOKEN_URL,
      authGatewayUrl: parsed.AUTH_GATEWAY_URL,
    },
    {},
  );
}
