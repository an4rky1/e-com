/**
 * @fileoverview The nine peers, re-exported from their own files.
 *
 * @remarks Auth and shop adapters live in `grpc-auth-peers.ts` and `grpc-shop-peers.ts`;
 * method paths live in `grpc-methods.ts`. This barrel keeps the original import path
 * working for `gateway.module.ts`, the public surface and the resilience suite, without
 * forcing a rename of every consumer when a sixth peer lands in its own file.
 */
export { METHOD } from './grpc-methods';
export {
  GrpcAccessControlClient,
  GrpcAuthFlowClient,
  GrpcCredentialVaultClient,
  GrpcIdentityClient,
  GrpcSessionClient,
} from './grpc-auth-peers';
export {
  GrpcBillingClient,
  GrpcCartClient,
  GrpcCatalogClient,
  GrpcOrderClient,
} from './grpc-shop-peers';
