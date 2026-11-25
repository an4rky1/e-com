/**
 * @fileoverview Shared defaults and bounds for peer-RPC deadlines.
 *
 * @remarks The four services that call peers over gRPC (cart, order, inventory, billing) share
 * one default and one bound pair; a service whose deadline genuinely differs, like auth-flow's,
 * keeps its own. Putting the shared values here means changing the shared default cannot drift
 * between the four configs.
 */

/** Default deadline applied to outbound peer RPCs, in milliseconds. */
export const GRPC_DEADLINE_MS = 5_000;
/** Lower bound a deployment may set for the peer-RPC deadline. */
export const GRPC_DEADLINE_MIN_MS = 100;
/** Upper bound a deployment may set for the peer-RPC deadline. */
export const GRPC_DEADLINE_MAX_MS = 60_000;
