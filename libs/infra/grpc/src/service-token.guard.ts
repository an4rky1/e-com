/**
 * @fileoverview Admits a gRPC call only when it carries the platform service token.
 *
 * @remarks Attached to {@link GrpcControllerBase} rather than registered per service: a new gRPC
 * controller then cannot be written without inheriting the check, and the failure mode where one
 * service ships an open port does not exist to be shipped.
 *
 * @remarks Fails closed at every branch — no metadata, no header, a repeated header, an empty
 * value, a wrong value. The one thing it never does is let a call through by accident, because
 * the accident would be an unauthenticated mutation of somebody's sessions.
 *
 * @remarks The comparison is timing-safe on the *digest*, not on the raw value: `crypto
 * .timingSafeEqual` throws on unequal lengths, so comparing a presented token against a stored
 * one directly would either leak the length or require padding. Hashing both sides first gives
 * equal-length buffers and spends the comparison on content alone.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  GRPC_SERVICE_TOKEN_METADATA_KEY,
  readServiceToken,
} from './service-token';

/** Length-safe equality: both sides reduced to a fixed-size digest before the compare. */
function digest(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * The request metadata, in whichever shape the transport exposes it.
 *
 * @remarks Three shapes, all real. Over the wire, Nest hands a gRPC guard the request
 * `Metadata` object *as* the RPC context — verified against a live server, not inferred from
 * the docs: the object has `internalRepr`/`options` and no `metadata` property at all. A raw
 * grpc-js server call instead carries it as `call.metadata`, and the Nest docs quote an
 * accessor, `getMetadata()`. A guard that knew only one of the three would pass its unit tests
 * and then refuse — or never even see — every real call arriving in the other shapes.
 */
function requestMetadata(context: ExecutionContext): { get?: (key: string) => unknown } | undefined {
  const call = context.switchToRpc().getContext() as {
    metadata?: { get?: (key: string) => unknown };
    getMetadata?: () => unknown;
    get?: (key: string) => unknown;
  } | null;
  if (!call || typeof call !== 'object') return undefined;

  const accessor =
    typeof call.getMetadata === 'function' ? call.getMetadata() : undefined;
  const property =
    call.metadata && typeof call.metadata.get === 'function' ? call.metadata : undefined;
  const asMetadata = typeof call.get === 'function' ? call : undefined;

  const metadata = accessor ?? property ?? asMetadata;
  return metadata && typeof (metadata as { get?: unknown }).get === 'function'
    ? (metadata as { get?: (key: string) => unknown })
    : undefined;
}

/** The single value of the token header, or `undefined` when there is not exactly one. */
function presentedToken(context: ExecutionContext): string | Buffer | undefined {
  const values = requestMetadata(context)?.get?.(GRPC_SERVICE_TOKEN_METADATA_KEY);

  if (!Array.isArray(values) || values.length !== 1) return undefined;

  const value = values[0];
  return typeof value === 'string' || Buffer.isBuffer(value) ? value : undefined;
}

@Injectable()
export class GrpcServiceTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  /**
   * @param serviceToken - the shared secret. Defaults to the environment, and a missing
   * `GRPC_SERVICE_TOKEN` therefore fails while Nest builds the controller's guards — at boot,
   * not on the first call a peer happens to make.
   *
   * @remarks `@Optional` is about `emitDecoratorMetadata`, not about optionality of the secret.
   * The emitted `design:paramtypes` names this parameter `String`, so Nest tries to resolve the
   * global `String` constructor as a provider and fails with `UnknownDependenciesException` for
   * every service whose controllers reach this guard. An optional parameter is left `undefined`
   * instead, and the default above — which does enforce the secret — runs in its place.
   */
  constructor(@Optional() serviceToken: string = readServiceToken()) {
    if (!serviceToken) {
      // The default path cannot produce this — `readServiceToken` refuses an empty value — but
      // a guard constructed by hand with `''` would digest nothing and admit a call presenting
      // nothing, which is the exact call this class exists to refuse.
      throw new Error('GrpcServiceTokenGuard requires a non-empty service token');
    }
    this.expected = digest(serviceToken);
  }

  canActivate(context: ExecutionContext): boolean {
    const presented = presentedToken(context);

    if (presented === undefined || !timingSafeEqual(digest(presented), this.expected)) {
      // No value from the environment in the message: an error that reaches a log is an error
      // that gets copied into a ticket. The expected token never appears, and neither does the
      // presented one.
      throw new UnauthorizedException(
        'gRPC calls must present the platform service token',
      );
    }

    return true;
  }
}
