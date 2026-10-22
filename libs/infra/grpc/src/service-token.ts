/**
 * @fileoverview The secret one service presents to another over gRPC.
 *
 * @remarks A peer connection inside the trust boundary is still a connection: without a shared
 * secret, anything that can reach a service's port can call `SetPassword` or `RevokeAllSessions`
 * and get an answer. Mutual TLS would bind the identity of the caller to a certificate, and it is
 * the stronger answer — but it needs a CA, a rotation story and an addressable identity per pod,
 * none of which this platform has yet. A single token in the request metadata is what it can have
 * today, and it is a strict improvement over an open port.
 *
 * @remarks The token lives in one variable, `GRPC_SERVICE_TOKEN`, read by both ends: the guard
 * that admits a call and the channel that places one. A per-service variable would be a second
 * secret per service with no second trust boundary to show for it — every service already trusts
 * every other one.
 *
 * @remarks There is no default, on either end. `envSecret` refuses to produce an empty value, so
 * a deployment that forgot the variable fails to boot on both sides of every call rather than
 * running a service that accepts whatever arrives.
 */
import { z } from 'zod';
import { envSecret, readNamespacedEnv } from '@auth/platform/config';

/**
 * Metadata key carrying the token.
 *
 * @remarks A platform-owned name, not `authorization`: the edge already puts a user's bearer
 * token in `authorization`, and one header doing both jobs is how a service-token check ends up
 * accepting a user's token — or the other way round.
 */
export const GRPC_SERVICE_TOKEN_METADATA_KEY = 'x-service-token';

const serviceTokenSchema = z.object({
  SERVICE_TOKEN: envSecret('the token services present to each other over gRPC'),
});

/**
 * Reads the shared token, or throws.
 *
 * @param env - source map. Injectable so a test never reaches into `process.env`.
 */
export function readServiceToken(env: NodeJS.ProcessEnv = process.env): string {
  return readNamespacedEnv('GRPC', serviceTokenSchema, env).SERVICE_TOKEN;
}

/**
 * Places the platform token in a call's metadata.
 *
 * @remarks Applied last, so a caller's own `x-service-token` cannot displace it. The token is a
 * property of the transport, not of the request, and no adapter should be able to choose it.
 *
 * @remarks `undefined` in, `undefined` out: a channel built without a token attaches nothing,
 * which is what keeps the server-side guard — not the client — the single place that decides
 * whether an unauthenticated call is acceptable.
 */
export function withServiceToken(
  metadata: Record<string, string> | undefined,
  serviceToken: string | undefined,
): Record<string, string> | undefined {
  if (!serviceToken) return metadata;
  return { ...metadata, [GRPC_SERVICE_TOKEN_METADATA_KEY]: serviceToken };
}
