/**
 * @fileoverview Service identity and endpoint registry.
 *
 * Why a registry instead of raw URLs in client code: the api-gateway needs to reach nine
 * services, and a typo in a URL string fails at request time with a DNS error. Resolving
 * through named endpoints makes an unknown target a startup error.
 */

export const ServiceNames = {
  API_GATEWAY: 'api-gateway',
  IDENTITY: 'identity',
  ACCESS_CONTROL: 'access-control',
  CREDENTIAL_VAULT: 'credential-vault',
  SESSION_TOKEN: 'session-token',
  AUTH_GATEWAY: 'auth-gateway',
  NOTIFICATION: 'notification',
  AUDIT_LOG: 'audit-log',
  ACCOUNT_SECURITY: 'account-security',
} as const;

export type ServiceName = (typeof ServiceNames)[keyof typeof ServiceNames];

/** Protobuf packages, `{service}.v1`. */
export const GrpcPackages = {
  IDENTITY: 'identity.v1',
  ACCESS_CONTROL: 'access_control.v1',
  CREDENTIAL_VAULT: 'credential_vault.v1',
  SESSION_TOKEN: 'session_token.v1',
  AUTH_GATEWAY: 'auth_gateway.v1',
  ACCOUNT_SECURITY: 'account_security.v1',
} as const;

export type GrpcPackage = (typeof GrpcPackages)[keyof typeof GrpcPackages];

export interface GrpcEndpoint {
  service: ServiceName;
  url: string;
  package: GrpcPackage;
  protoFile: string;
}