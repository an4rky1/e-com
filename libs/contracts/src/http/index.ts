/**
 * @fileoverview The HTTP contract between the gateway and its browser clients.
 *
 * @remarks Imported as `@auth/contracts/http` — deliberately not re-exported from the root
 * barrel, whose names are the internal contracts (gRPC mirrors, event envelopes) and would
 * collide with these (`CreateUserRequest`, `UserResponse` and friends exist on both sides,
 * describing two different wires).
 */
export * from './api';
export * from './routes';
export * from './storefront';
