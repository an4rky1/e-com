/**
 * Scaffolds the thin app shells.
 *
 * @remarks Deliberately thin: an app owns process concerns (bootstrap, signals, gRPC server)
 * and nothing else. Every decision lives in `libs/domains/<service>` or a platform lib, so
 * the same service can be run from a different bootstrap — a test harness, a CLI, a serverless
 * adapter — without duplicating wiring.
 */
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Writes only what is not there yet.
 *
 * @remarks The committed shells carry edits the template has outgrown — `tracing.ts`,
 * `ObservabilityModule`, the odd custom comment. Regenerating them would trade those edits
 * for whatever the template happened to say today, so the scaffold seeds new services and
 * leaves existing files alone. Deleting a directory is how you ask it to rebuild one.
 */
const writeIfMissing = (file, contents) => {
  if (existsSync(file)) return;
  writeFileSync(file, contents);
};

const SERVICES = [
  { dir: 'identity', lib: 'identity', module: 'createIdentityModule', serviceName: 'identity', port: 3001, grpc: 'identity.v1', publisher: true },
  { dir: 'access-control', lib: 'access-control', module: 'createAccessControlModule', serviceName: 'access-control', port: 3002, grpc: 'access_control.v1', publisher: true },
  { dir: 'credential-vault', lib: 'credential-vault', module: 'createCredentialVaultModule', serviceName: 'credential-vault', port: 3003, grpc: 'credential_vault.v1', publisher: true },
  { dir: 'session', lib: 'session', module: 'createSessionModule', serviceName: 'session', port: 3004, grpc: 'session.v1', publisher: true },
  { dir: 'auth-flow', lib: 'auth-flow', module: 'createAuthFlowModule', serviceName: 'auth-flow', port: 3005, grpc: 'auth_flow.v1', downstream: true, publisher: true },
  { dir: 'mfa', lib: 'mfa', module: 'createMfaModule', serviceName: 'mfa', port: 3006, grpc: null, publisher: true },
  { dir: 'api-key', lib: 'api-key', module: 'createApiKeyModule', serviceName: 'api-key', port: 3007, grpc: null, publisher: true },
  { dir: 'account-security', lib: 'account-security', module: 'createAccountSecurityModule', serviceName: 'account-security', port: 3008, grpc: 'account_security.v1', publisher: true },
  { dir: 'notification', lib: 'notification', module: 'createNotificationModule', serviceName: 'notification', port: 3009, grpc: null, kafka: true },

  // --- e-commerce ---------------------------------------------------------------
  // Ports continue after audit-log's 3010; gRPC follows the workspace rule of HTTP+10000.
  // `alias` differs from `@auth/domains/*`: commerce domains import through `@shop/*`,
  // the graph name matches the alias so nx and TypeScript tell the same story.
  // gRPC peers ride in `peers`: one static channel spanning the packages this service
  // calls, addresses from `<PKG>_GRPC_URL` with a localhost default.
  {
    dir: 'catalog', lib: 'catalog', module: 'createCatalogModule', alias: '@shop/domains/catalog',
    serviceName: 'catalog', port: 3011, grpc: 'catalog.v1', publisher: true,
  },
  {
    dir: 'cart', lib: 'cart', module: 'createCartModule', alias: '@shop/domains/cart',
    serviceName: 'cart', port: 3012, grpc: 'cart.v1', publisher: false,
    peers: [{ proto: 'catalog.proto', pkg: 'catalog.v1', env: 'CATALOG_GRPC_URL', url: 'localhost:13011' }],
  },
  {
    dir: 'inventory', lib: 'inventory', module: 'createInventoryModule', alias: '@shop/domains/inventory',
    serviceName: 'inventory', port: 3013, grpc: 'inventory.v1', publisher: true,
  },
  {
    dir: 'billing', lib: 'billing', module: 'createBillingModule', alias: '@shop/domains/billing',
    serviceName: 'billing', port: 3014, grpc: 'billing.v1', publisher: true,
  },
  {
    dir: 'order', lib: 'order', module: 'createOrderModule', alias: '@shop/domains/order',
    serviceName: 'order', port: 3015, grpc: 'order.v1', publisher: true,
    peers: [
      { proto: 'cart.proto', pkg: 'cart.v1', env: 'CART_GRPC_URL', url: 'localhost:13012' },
      { proto: 'inventory.proto', pkg: 'inventory.v1', env: 'INVENTORY_GRPC_URL', url: 'localhost:13013' },
      { proto: 'billing.proto', pkg: 'billing.v1', env: 'BILLING_GRPC_URL', url: 'localhost:13014' },
    ],
  },
];

/**
 * The `ServiceNames` key for a service directory, matching the registry in
 * `@auth/contracts/grpc/endpoints.ts`: `access-control` → `ACCESS_CONTROL`.
 */
const serviceNamesKey = (service) =>
  service.dir.split('-').map((part) => part.toUpperCase()).join('_');

/**
 * Proto files are named after their gRPC package (`auth_flow.v1`), which is underscored,
 * not after the service directory (`auth-flow`). Deriving one from the other is how a
 * service ends up pointing at a file that does not exist — at boot, not at compile time.
 */
const PROTO_BY_SERVICE = {
  identity: 'identity',
  'access-control': 'access_control',
  'credential-vault': 'credential_vault',
  'session': 'session',
  'auth-flow': 'auth_flow',
  'account-security': 'account_security',
  catalog: 'catalog',
  cart: 'cart',
  inventory: 'inventory',
  billing: 'billing',
  order: 'order',
};

const protoRelative = (service) =>
  `path.resolve(__dirname, '../../../libs/contracts/proto/${PROTO_BY_SERVICE[service]}.proto')`;

for (const service of SERVICES) {
  const root = join('apps', service.dir);
  mkdirSync(join(root, 'src'), { recursive: true });

  const grpcMerge = service.grpc
    ? `
  // gRPC joins the existing HTTP server rather than opening a second one: one process, one
  // port, two transports.
  app.connectMicroservice(
    {
      transport: Transport.GRPC,
      options: {
        url: process.env.GRPC_URL ?? \`\${BIND_HOST}:${service.port + 10000}\`,
        package: '${service.grpc}',
        protoPath: ${protoRelative(service.dir)},
      },
    },
    { inheritAppConfig: true },
  );
`
    : '';

  writeIfMissing(
    join(root, 'src', 'tracing.ts'),
    `/**
 * @fileoverview Starts the trace SDK before this process's composition root loads.
 *
 * @remarks One line by design: the ordering between this import and \`.app.module\` is the
 * feature, so the file exists to keep the call out of \`main.ts\`'s own logic. See
 * \`startTracing\` for the instrumentation list and the \`OTEL_*\` surface.
 */
import { ServiceNames } from '@auth/contracts';
import { startTracing } from '@auth/platform/observability';

startTracing(ServiceNames.${serviceNamesKey(service)});
`,
  );

  writeIfMissing(
    join(root, 'src', 'main.ts'),
    `/**
 * @fileoverview Process entry point for ${service.serviceName}.
 *
 * @remarks Thin by design: wiring lives in \`libs/domains/${service.lib}\`. This file owns only
 * what is genuinely process-scoped — the HTTP port, the gRPC server, signal handling and
 * graceful shutdown order.
 */
import 'reflect-metadata';
import { ServiceNames } from '@auth/contracts';
import './tracing';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
${service.grpc ? "import { Transport } from '@nestjs/microservices';\n" : ''}import { AppModule } from './app.module';

const DEFAULT_PORT = ${service.port};
const BIND_HOST = '0.0.0.0';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

${grpcMerge}
  await app.startAllMicroservices();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port, BIND_HOST);

  logger.log(\`\${process.env.SERVICE_NAME ?? ServiceNames.${serviceNamesKey(service)}} listening on port \${port}\`);
}

bootstrap().catch((error: unknown) => {
  // Logging and a non-zero exit, never a silent swallow: a service that dies during bootstrap
  // must be visibly dead to its orchestrator.
  console.error('Bootstrap failed', error);
  process.exit(1);
});
`,
  );

  writeIfMissing(
    join(root, 'src', 'app.module.ts'),
    `/**
 * @fileoverview Composition root for ${service.serviceName}.
 *
 * @remarks Imports the service's module from \`libs/\` rather than declaring providers here.
 * Everything this service does is testable without booting Nest, because the composition root
 * contains no behaviour to test.
 */
import { ServiceNames } from '@auth/contracts';
import { Module } from '@nestjs/common';
import { PlatformConfigModule } from '@auth/platform/config';
import { ErrorHandlingModule } from '@auth/platform/error-handling';
import { HealthModule } from '@auth/platform/health';
import { ObservabilityModule } from '@auth/platform/observability';
${service.kafka ? `import { createKafkaModule } from '@auth/infra/kafka';` : ''}
import { ShutdownService } from '@auth/platform/shutdown';
import { ${service.module} } from '${service.alias ?? `@auth/domains/${service.lib}`}';
${service.publisher ? `import { createKafkaPublisher } from '@auth/infra/kafka';

/**
 * Outbox transport, built here because a module factory cannot receive it through DI.
 *
 * @remarks Composition lives in the app: it is the only layer allowed to know that events
 * leave this process over Kafka. The domain module sees nothing but the transport port.
 */
const eventPublisher = createKafkaPublisher();` : ''}
${service.peers ? `import { createStaticGrpcChannel } from '@auth/infra/grpc';
import path from 'node:path';

/**
 * Downstream channels for the peers this service calls over gRPC.
 *
 * @remarks One channel spans every peer package, because a channel built from a single
 * proto can only dispatch that package's methods — an orchestrator wired with one proto
 * works for its first dependency and fails on its second with an error that reads like a
 * missing method rather than a missing address.
 */
const PROTO_DIR = path.resolve(__dirname, '../../../libs/contracts/proto');

const peerChannel = createStaticGrpcChannel({
  protoPaths: [${service.peers.map((p) => `path.join(PROTO_DIR, '${p.proto}')`).join(', ')}],
  url: process.env.${service.peers[0].env} ?? '${service.peers[0].url}',
  addresses: {
${service.peers.map((p) => `    '${p.pkg}': process.env.${p.env} ?? '${p.url}',`).join('\n')}
  },
});` : ''}
${service.downstream ? `import { createStaticGrpcChannel } from '@auth/infra/grpc';
import path from 'node:path';

/**
 * Downstream channel for the four peers this orchestrator calls.
 *
 * @remarks Built eagerly rather than through DI: \`createAuthFlowModule\` is invoked inside an
 * \`@Module\` decorator, where no injection container exists yet. Keeping the construction here
 * means the library still only ever sees the \`GrpcChannel\` port.
 *
 * @remarks One channel spans four proto packages, each on its own host. A channel built from a
 * single proto can only dispatch that package's methods, so an orchestrator wired that way
 * works for its first dependency and fails on its second — with an error that reads like a
 * missing method rather than a missing address.
 */
const PROTO_DIR = path.resolve(__dirname, '../../../libs/contracts/proto');

const downstreamChannel = createStaticGrpcChannel({
  protoPaths: [
    path.join(PROTO_DIR, 'identity.proto'),
    path.join(PROTO_DIR, 'credential_vault.proto'),
    path.join(PROTO_DIR, 'session.proto'),
    path.join(PROTO_DIR, 'mfa.proto'),
  ],
  url: process.env.IDENTITY_GRPC_URL ?? 'localhost:31001',
  addresses: {
    'identity.v1': process.env.IDENTITY_GRPC_URL ?? 'localhost:31001',
    'credential_vault.v1': process.env.CREDENTIAL_VAULT_GRPC_URL ?? 'localhost:31003',
    'session.v1': process.env.SESSION_GRPC_URL ?? 'localhost:31004',
    'mfa.v1': process.env.MFA_GRPC_URL ?? 'localhost:31006',
  },
});` : ''}

@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot(ServiceNames.${serviceNamesKey(service)}),
    ObservabilityModule.forRoot(ServiceNames.${serviceNamesKey(service)}),
${service.kafka ? `    // Supplies the Kafka consumer the notification module exports but does not
    // provide: the module is consumer-only and takes its transport from here.
    createKafkaModule(),` : ''}
    ${service.module}({${[
      service.publisher ? 'publisher: eventPublisher' : null,
      service.peers ? 'grpcChannel: peerChannel' : null,
      service.downstream ? 'grpcChannel: downstreamChannel' : null,
    ]
      .filter(Boolean)
      .join(', ')}}),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
`,
  );

  writeIfMissing(
    join(root, 'project.json'),
    `${JSON.stringify(
      {
        name: `@app/${service.dir}`,
        $schema: '../../node_modules/nx/schemas/project-schema.json',
        sourceRoot: `apps/${service.dir}/src`,
        projectType: 'application',
        tags: ['type:app', `domain:${service.dir}`],
        targets: {
          typecheck: {
            executor: 'nx:run-commands',
            options: { command: `tsc -p apps/${service.dir}/tsconfig.app.json --noEmit` },
          },
          serve: {
            executor: 'nx:run-commands',
            options: {
              // tsconfig-paths is required at runtime: Node resolves `@auth/*` through the
              // tsconfig `paths` map, which plain Node has no knowledge of.
              command: `TS_NODE_PROJECT=apps/${service.dir}/tsconfig.app.json node -r ts-node/register/transpile-only -r tsconfig-paths/register apps/${service.dir}/src/main.ts`,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  writeIfMissing(
    join(root, 'tsconfig.app.json'),
    `${JSON.stringify(
      {
        extends: '../../tsconfig.backend.base.json',
        compilerOptions: {
          outDir: '../../dist/out-tsc',
          // ts-node runs the app straight from source; without an explicit rootDir it infers
          // one from the entry file and then rejects the imports that reach into libs/.
          rootDir: '../..',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
}

console.log(`scaffolded ${SERVICES.length} thin apps`);