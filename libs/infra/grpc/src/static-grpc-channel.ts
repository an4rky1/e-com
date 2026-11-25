import {
  credentials,
  loadPackageDefinition,
  Metadata,
  type ServiceClientConstructor,
} from '@grpc/grpc-js';
import { DEFAULT_DEADLINE_MS, GrpcRetryRegistry, type GrpcCallOptions, type GrpcChannel, type ConnectivityState } from './grpc-channel.port';
import { loadPackageDefinitionFor } from './grpc-server';
import { withServiceToken } from './service-token';

/**
 * A loaded client's methods, keyed by method name.
 *
 * @remarks The three levels are distinct and easy to conflate: proto package -> service ->
 * method. `grpc.loadPackageDefinition` returns exactly that shape, and a channel that skips a
 * level silently dispatches nothing.
 */
type ServiceMethods = Record<string, UnaryCall>;
type PackageClients = Record<string, ServiceMethods>;

interface UnaryCall {
  (request: unknown, callback: (error: Error | null, response: unknown) => void): void;
  (request: unknown, metadata: unknown, options: { deadline: Date }, callback: (error: Error | null, response: unknown) => void): void;
}

/**
 * Channel built directly from a loaded proto, without `ClientGrpcProxy`.
 *
 * @remarks Needed where a module has to be assembled at import time rather than through DI —
 * `createAuthFlowModule(options)` is called in an `@Module` decorator, where no container
 * exists yet. Going through the proxy there would require bootstrapping Nest to build a
 * channel, which is circular.
 */
/** Builds gRPC metadata; an empty object rather than `null` so the 4-arg overload is chosen. */
function toMetadata(metadata?: Record<string, string>): Metadata {
  const instance = new Metadata();
  for (const [key, value] of Object.entries(metadata ?? {})) {
    instance.set(key, value);
  }
  return instance;
}

export class StaticGrpcChannel implements GrpcChannel {
  private state: ConnectivityState = 'IDLE';
  private closed = false;

  constructor(
    /** One client per proto package, because each package is served by a different host. */
    private readonly clientsByPackage: Map<string, PackageClients>,
    private readonly retryRegistry: GrpcRetryRegistry,
    private readonly defaultDeadlineMs: number,
    /**
     * Presented on every call. Optional for the same reason as on `NestGrpcChannel`: the token
     * is policy, the channel is transport, and a channel that silently attaches nothing is how
     * one of the two implementations ends up unauthenticated while the other is not.
     */
    private readonly serviceToken?: string,
  ) {}

  async unary<TRequest extends object, TResponse>(
    method: string,
    request: TRequest,
    options?: Partial<GrpcCallOptions>,
  ): Promise<TResponse> {
    // A method path is `/package.Service/Method`, so the second segment is the package AND
    // the service name run together. The package has to be recovered by matching against the
    // loaded packages: splitting on dots and re-casing the remainder guesses at a service
    // name, and a wrong guess produces a method that is "absent" for no visible reason.
    //
    // @remarks Each package resolves to its own host, because an orchestrator calls four
    // services that each listen on a different port.
    const [, packageAndService = '', methodName = ''] = method.split('/');

    let packageName = '';
    let serviceName = '';
    for (const candidate of this.clientsByPackage.keys()) {
      if (packageAndService.startsWith(`${candidate}.`)) {
        packageName = candidate;
        serviceName = packageAndService.slice(candidate.length + 1);
        break;
      }
    }

    const client = this.clientsByPackage.get(packageName)?.[serviceName];

    if (!client || typeof client[methodName] !== 'function') {
      throw new Error(
        `Method "${method}" is absent from the loaded proto definition — load the proto ` +
          `declaring package "${packageName}" and give it an address`,
      );
    }

    const deadline = options?.deadline ?? Date.now() + this.defaultDeadlineMs;
    this.state = 'READY';

    return new Promise<TResponse>((resolve, reject) => {
      // Called as `client[method](...)`, never through an extracted reference. gRPC client
      // methods are bound to their own instance; `const invoke = client.GetUser` detaches
      // `this` and fails at call time with `checkOptionalUnaryResponseArguments` — a check
      // that lives on the instance the method was supposed to receive.
      //
      // Metadata is always passed, even when empty, so the overload resolution picks
      // `(request, metadata, options, callback)` — the only form that carries a deadline.
      client[methodName](
        request,
        toMetadata(withServiceToken(options?.metadata, this.serviceToken)),
        { deadline: new Date(deadline) },
        (error: Error | null, response: unknown) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response as TResponse);
        },
      );
    });
  }

  getState(): ConnectivityState {
    return this.closed ? 'SHUTDOWN' : this.state;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = 'SHUTDOWN';
  }
}

/**
 * Loads one or more protos and returns a ready-to-use channel.
 *
 * @remarks **Multiple protos is the normal case, not an edge case.** An orchestrator calls
 * `identity.v1`, `credential_vault.v1`, `session.v1` and `mfa.v1` — four packages, each
 * declared in its own file. A channel built from one proto can only dispatch that package's
 * methods, so a single-proto channel makes cross-service orchestration impossible while
 * looking perfectly healthy until the first call to a second peer.
 *
 * The definitions are merged before `loadPackageDefinition`, so each package is loaded once
 * and cached by {@link loadServiceDefinition}; loading the same proto twice would produce
 * incompatible message constructors.
 */
/**
 * Splits the fully-qualified service names out of a raw proto definition.
 *
 * @remarks `loadSync` returns one flat entry per fully-qualified name, and the entries are
 * not shaped alike: a service definition's values are method descriptors (each carrying a
 * `path`), while a message type carries `format`/`type` and, crucially, a pile of functions.
 * Treating "any function" as a client constructor therefore descends into message types and
 * invokes `UserResponse.fromObject` as though it were a service — the crash reads as
 * `identity.v1.UserResponse: object expected`.
 *
 * So services are identified structurally, not by leaf type.
 */
function collectServiceNames(definition: Record<string, unknown>): string[] {
  return Object.entries(definition)
    .filter(([, entry]) => isServiceDefinition(entry))
    .map(([fullName]) => fullName);
}

function isServiceDefinition(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  // A message type is self-describing; a service is not.
  if ('format' in (entry as object)) return false;

  const values = Object.values(entry as Record<string, unknown>);
  return (
    values.length > 0 &&
    values.every(
      (method) =>
        typeof method === 'object' && method !== null && 'path' in (method as object),
    )
  );
}

/**
 * Resolves `client namespace -> package path -> service name -> constructor`.
 *
 * @remarks The namespace is nested by dot segments, so `credential_vault.v1` is reached as
 * `namespace.credential_vault.v1`. Walking it by name — rather than flattening and guessing —
 * is what keeps a message constructor from being mistaken for a client.
 */
function resolveClientConstructor(
  namespace: Record<string, unknown>,
  serviceFullName: string,
): ServiceClientConstructor | undefined {
  const segments = serviceFullName.split('.');
  const serviceName = segments.pop() as string;

  let node: unknown = namespace;
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }

  if (typeof node !== 'object' || node === null) return undefined;
  const candidate = (node as Record<string, unknown>)[serviceName];
  return typeof candidate === 'function'
    ? (candidate as ServiceClientConstructor)
    : undefined;
}

export function createStaticGrpcChannel(options: {
  protoPath?: string;
  /** Prefer this over `protoPath` when a service spans several peer packages. */
  protoPaths?: string[];
  /** Default address for any package without its own entry in `addresses`. */
  url: string;
  /** Per-proto-package address, e.g. `{ 'identity.v1': 'localhost:31001' }`. */
  addresses?: Record<string, string>;
  retryRegistry?: GrpcRetryRegistry;
  defaultDeadlineMs?: number;
  insecure?: boolean;
  /** The shared secret placed in `x-service-token` on every call this channel makes. */
  serviceToken?: string;
}): GrpcChannel {
  const paths = options.protoPaths ?? (options.protoPath ? [options.protoPath] : []);
  if (paths.length === 0) {
    throw new Error('createStaticGrpcChannel requires protoPath or protoPaths');
  }

  const registry = options.retryRegistry ?? new GrpcRetryRegistry();
  const credentialsFor = () =>
    options.insecure === false ? credentials.createSsl() : credentials.createInsecure();

  const clientsByPackage = new Map<string, PackageClients>();

  // Each proto is loaded on its own and the resulting clients are merged afterwards.
  //
  // @remarks Loading several files into one shared definition does not work: proto-loader keeps
  // a message-type registry per call, and merging the definitions before the loader sees them
  // leaves a service whose fields resolve against types it cannot find — surfacing as
  // `<pkg>.<Message>: object expected` at call time. Per-file loading keeps each registry
  // self-contained, which is also exactly the situation that is known to work.
  for (const protoPath of paths) {
    // `loadPackageDefinition` is what turns the flat, fully-qualified definition that
    // `loadSync` returns into the client namespace — one nested object per package, whose
    // leaves are the client constructors. Flattening must happen on THAT, not on the raw
    // definition: the raw form's leaves are message and method descriptors, so flattening it
    // yields keys like `identity.v1.IdentityService.GetUser` and no client constructor.
    const namespace = loadPackageDefinition(
      loadPackageDefinitionFor(protoPath) as unknown as Parameters<
        typeof loadPackageDefinition
      >[0],
    ) as unknown as Record<string, unknown>;

    for (const serviceFullName of collectServiceNames(
      loadPackageDefinitionFor(protoPath),
    )) {
      const ctor = resolveClientConstructor(namespace, serviceFullName);
      if (!ctor) {
        throw new Error(
          `Proto ${protoPath} declares service ${serviceFullName} but the loaded ` +
            `namespace has no constructor for it`,
        );
      }

      const lastDot = serviceFullName.lastIndexOf('.');
      const packageName = serviceFullName.slice(0, lastDot);
      const serviceName = serviceFullName.slice(lastDot + 1);
      const address = options.addresses?.[packageName] ?? options.url;

      const ClientCtor = ctor as unknown as new (
        addr: string,
        creds: ReturnType<typeof credentials.createInsecure>,
      ) => ServiceMethods;

      const existing = clientsByPackage.get(packageName) ?? {};
      existing[serviceName] = new ClientCtor(address, credentialsFor());
      clientsByPackage.set(packageName, existing);
    }
  }

  return new StaticGrpcChannel(
    clientsByPackage,
    registry,
    options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS,
    options.serviceToken,
  );
}
