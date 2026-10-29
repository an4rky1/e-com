/**
 * @fileoverview Who is this person?
 *
 * @remarks Declared in the domain and implemented over gRPC in `infrastructure/grpc/`, so the
 * flow machine never learns that identity is a separate service with its own database. That
 * separation is what lets identity change its storage without a single line of the state
 * machine moving — and what lets this library be tested without a database or a socket.
 */

/** The subset of a user record the gateway needs, and no more. */
export interface IdentityUserView {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly emailVerified: boolean;
}

export const IDENTITY_PORT = Symbol('IDENTITY_PORT');

export interface IdentityPort {
  /**
   * Case-insensitive lookup by address.
   *
   * @remarks Returns `null` rather than throwing for an unknown address, because the caller
   * must not be able to tell the two apart from the way the call failed.
   */
  findUserByEmail(email: string): Promise<IdentityUserView | null>;

  findUserById(userId: string): Promise<IdentityUserView | null>;
}