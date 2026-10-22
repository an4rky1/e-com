/**
 * @fileoverview DI token for "something that can answer a permission decision".
 *
 * @remarks The interface lives in the application layer, with the facade that implements it;
 * this file owns only the token. That keeps the dependency direction right — the guard
 * (presentation) may know about the application, never the reverse — while still letting a
 * caller bind a gRPC-backed checker instead of the in-process facade.
 *
 * @remarks The port exists so the guard needs one method rather than a CQRS bus: the guard
 * runs on every request, and a unit test of "does this deny correctly" should not have to
 * stand up a command bus to answer it.
 */
import type { PermissionChecker } from '../../application/facade/access-control.service';

export const PERMISSION_CHECKER = Symbol('PERMISSION_CHECKER');

export type { PermissionChecker };