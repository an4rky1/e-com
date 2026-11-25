/**
 * @fileoverview Default gRPC peer addresses, shared by the auth-flow app module and the e2e
 * tooling so the two cannot drift.
 *
 * @remarks The `env` is the override every deployment uses; the `url` is the address the e2e
 * services are expected to answer on when the caller sets nothing. Both the app module and the
 * tool read this table, so a change here moves both at once.
 */
import { GrpcPackages, type GrpcPackage } from './endpoints';

/** The env var a deployment overrides the address with, and the fallback address. */
export interface PeerAddressDefault {
  readonly env: string;
  readonly url: string;
}

export const PeerAddressDefaults: Readonly<Partial<Record<GrpcPackage, PeerAddressDefault>>> = {
  [GrpcPackages.IDENTITY]: { env: 'IDENTITY_GRPC_URL', url: 'localhost:31001' },
  [GrpcPackages.CREDENTIAL_VAULT]: {
    env: 'CREDENTIAL_VAULT_GRPC_URL',
    url: 'localhost:31003',
  },
  [GrpcPackages.SESSION]: { env: 'SESSION_GRPC_URL', url: 'localhost:31004' },
  [GrpcPackages.MFA]: { env: 'MFA_GRPC_URL', url: 'localhost:31006' },
  [GrpcPackages.AUTH_FLOW]: { env: 'AUTH_FLOW_GRPC_URL', url: 'localhost:31005' },
  // Account-security owns the failure counters and the lock: like every peer, the address is
  // platform-owned — this service reads it and decides nothing about it.
  [GrpcPackages.ACCOUNT_SECURITY]: {
    env: 'ACCOUNT_SECURITY_GRPC_URL',
    url: 'localhost:31007',
  },
};

/** The env-overridden address for every registered package, as a plain `{package: url}` map. */
export function resolvePeerAddresses(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(PeerAddressDefaults).map(([pkg, def]) => [pkg, env[def.env] ?? def.url]),
  );
}
