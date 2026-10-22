import { Controller, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { ServiceDefinition } from '@grpc/grpc-js';
import { loadSync, type Options } from '@grpc/proto-loader';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { GrpcServiceTokenGuard } from './service-token.guard';

/**
 * Proto loading, done once and cached.
 *
 * @remarks Loading a proto twice produces two incompatible sets of message
 * constructors: a value serialised by one is rejected by the other, and the failure surfaces
 * as a confusing field-level type error deep inside a call.
 */
const LOADER_OPTIONS: Options = {
  keepCase: false,
  // `longs: String` is mandatory. An int64 that exceeds 2^53 silently loses precision as a
  // JS number, and a token's `iat`/`exp` drifting by a millisecond is a real outage.
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

const definitions = new Map<string, ServiceDefinition>();
const packageDefinitions = new Map<string, Record<string, unknown>>();

/**
 * Full proto package definition, keyed by package name.
 *
 * @remarks Distinct from {@link loadServiceDefinition}, which returns only the first service in
 * the file and drops the package name. Merging those is how a channel ends up keyed
 * `CredentialVaultService` instead of `credential_vault.v1.CredentialVaultService` — and then
 * every address lookup misses and every call fails as "not a constructor".
 */
export function loadPackageDefinitionFor(
  protoPath: string,
): Record<string, unknown> {
  const cached = packageDefinitions.get(protoPath);
  if (cached) return cached;

  const resolved = protoPath.startsWith('<rootDir>')
    ? join(__dirname, protoPath.replace('<rootDir>/', ''))
    : protoPath;

  const definition = loadSync(resolved, LOADER_OPTIONS) as unknown as Record<
    string,
    unknown
  >;
  packageDefinitions.set(protoPath, definition);
  return definition;
}

export function loadServiceDefinition(protoPath: string): ServiceDefinition {
  const cached = definitions.get(protoPath);
  if (cached) return cached;

  const resolved = protoPath.startsWith('<rootDir>')
    ? join(__dirname, protoPath.replace('<rootDir>/', ''))
    : protoPath;

  const loaded = loadSync(resolved, LOADER_OPTIONS);
  const [serviceName] = Object.keys(loaded);
  const service = loaded[serviceName];

  // `addService` needs the raw ServiceDefinition, not the flattened client object.
  const definition = service as unknown as ServiceDefinition;
  definitions.set(protoPath, definition);
  return definition;
}

/**
 * Base class for gRPC controllers.
 *
 * @remarks Nest's `mergeMicroservice` requires a controller with no HTTP routes. Deriving
 * from this keeps that invariant from being forgotten.
 *
 * @remarks **Subclasses must still declare their own `@Controller()`.** `emitDecoratorMetadata`
 * does not inherit across class inheritance: a subclass with no decorator of its own gets no
 * `design:paramtypes`, so Nest constructs it with zero arguments and every injected dependency
 * is `undefined`. The service boots cleanly and fails on the first request — which is why this
 * note is here rather than only in the subclasses.
 *
 * @remarks The service-token guard is declared here rather than in each service's module, for
 * the same reason the base class exists: authentication that can be forgotten is authentication
 * that will be. `@UseGuards` is read through the prototype chain, so a subclass inherits it
 * without declaring anything — `spec/service-token.guard.spec.ts` asserts exactly that against
 * this repository's Nest version, because "Nest reads parent metadata" is the kind of claim that
 * is true until a dependency moves.
 */
@Controller()
@UseGuards(GrpcServiceTokenGuard)
export abstract class GrpcControllerBase {
  protected readonly logger = new Logger(this.constructor.name);
}

export { GrpcMethod };