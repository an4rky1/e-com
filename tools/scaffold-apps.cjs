/**
 * Scaffolds the thin app shells.
 *
 * @remarks Deliberately thin: an app owns process concerns (bootstrap, signals, gRPC server)
 * and nothing else. Every decision lives in `libs/domains/<service>` or a platform lib, so
 * the same service can be run from a different bootstrap — a test harness, a CLI, a serverless
 * adapter — without duplicating wiring.
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SERVICES = [
  { dir: 'identity', lib: 'identity', module: 'createIdentityModule', serviceName: 'identity', port: 3001, grpc: 'identity.v1', publisher: true },
  { dir: 'access-control', lib: 'access-control', module: 'createAccessControlModule', serviceName: 'access-control', port: 3002, grpc: 'access_control.v1', publisher: true },
  { dir: 'credential-vault', lib: 'credential-vault', module: 'createCredentialVaultModule', serviceName: 'credential-vault', port: 3003, grpc: 'credential_vault.v1', publisher: true },
  { dir: 'session-token', lib: 'session-token', module: 'createSessionTokenModule', serviceName: 'session-token', port: 3004, grpc: 'session_token.v1', publisher: true },
  { dir: 'auth-gateway', lib: 'auth-gateway', module: 'createAuthGatewayModule', serviceName: 'auth-gateway', port: 3005, grpc: 'auth_gateway.v1', downstream: true, publisher: true },
  { dir: 'mfa', lib: 'mfa', module: 'createMfaModule', serviceName: 'mfa', port: 3006, grpc: null, publisher: true },
  { dir: 'api-key', lib: 'api-key', module: 'createApiKeyModule', serviceName: 'api-key', port: 3007, grpc: null, publisher: true },
  { dir: 'account-security', lib: 'account-security', module: 'createAccountSecurityModule', serviceName: 'account-security', port: 3008, grpc: 'account_security.v1', publisher: true },
  { dir: 'notification', lib: 'notification', module: 'createNotificationModule', serviceName: 'notification', port: 3009, grpc: null, kafka: true },
];

/**
 * Proto files are named after their gRPC package (`auth_gateway.v1`), which is underscored,
 * not after the service directory (`auth-gateway`). Deriving one from the other is how a
 * service ends up pointing at a file that does not exist — at boot, not at compile time.
 */
const PROTO_BY_SERVICE = {
  identity: 'identity',
  'access-control': 'access_control',
  'credential-vault': 'credential_vault',
  'session-token': 'session_token',
  'auth-gateway': 'auth_gateway',
  'account-security': 'account_security',
};

const protoRelative = (service) =>
  `path.resolve(__dirname, '../../../libs/contracts/proto/${PROTO_BY_SERVICE[service]}.proto')`;

for (const service of SERVICES) {
  const root = join('apps', service.dir);
  mkdirSync(join(root, 'src'), { recursive: true });

  const grpcImport = service.grpc
    ? `import { loadServiceDefinition } from '@auth/infra/grpc';`
    : null;

  const grpcMerge = service.grpc
    ? `
  // gRPC joins the existing HTTP server rather than opening a second one: one process, one
  // port, two transports.
  app.connectMicroservice(
    {
      transport: Transport.GRPC,
      options: {
        url: process.env.GRPC_URL ?? '0.0.0.0:${service.port + 10000}',
        package: '${service.grpc}',
        protoPath: ${protoRelative(service.dir)},
      },
    },
    { inheritAppConfig: true },
  );
`
    : '';

  writeFileSync(
    join(root, 'src', 'main.ts'),
    `/**
 * @fileoverview Process entry point for ${service.serviceName}.
 *
 * @remarks Thin by design: wiring lives in \`libs/domains/${service.lib}\`. This file owns only
 * what is genuinely process-scoped — the HTTP port, the gRPC server, signal handling and
 * graceful shutdown order.
 */
import 'reflect-metadata';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
${service.grpc ? "import { Transport } from '@nestjs/microservices';\n" : ''}${grpcImport ? grpcImport + '\n' : ''}import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

${grpcMerge}
  await app.startAllMicroservices();
  await app.listen(Number(process.env.PORT ?? ${service.port}), '0.0.0.0');

  logger.log(\`\${process.env.SERVICE_NAME ?? '${service.serviceName}'} listening on port \${process.env.PORT ?? ${service.port}}\`);
}

bootstrap().catch((error: unknown) => {
  // Logging and a non-zero exit, never a silent swallow: a service that dies during bootstrap
  // must be visibly dead to its orchestrator.
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', error);
  process.exit(1);
});
`,
  );

  writeFileSync(
    join(root, 'src', 'app.module.ts'),
    `/**
 * @fileoverview Composition root for ${service.serviceName}.
 *
 * @remarks Imports the service's module from \`libs/\` rather than declaring providers here.
 * Everything this service does is testable without booting Nest, because the composition root
 * contains no behaviour to test.
 */
import { Module } from '@nestjs/common';
import { PlatformConfigModule } from '@auth/platform/config';
import { ErrorHandlingModule } from '@auth/platform/error-handling';
import { HealthModule } from '@auth/platform/health';
${service.kafka ? `import { createKafkaModule } from '@auth/infra/kafka';` : ''}
import { ShutdownService } from '@auth/platform/shutdown';
import { ${service.module} } from '@auth/domains/${service.lib}';
${service.publisher ? `import { createKafkaPublisher } from '@auth/infra/kafka';

/**
 * Outbox transport, built here because a module factory cannot receive it through DI.
 *
 * @remarks Composition lives in the app: it is the only layer allowed to know that events
 * leave this process over Kafka. The domain module sees nothing but the transport port.
 */
const eventPublisher = createKafkaPublisher();` : ''}
${service.downstream ? `import { createStaticGrpcChannel } from '@auth/infra/grpc';
import path from 'node:path';

/**
 * Downstream channel for the four peers this orchestrator calls.
 *
 * @remarks Built eagerly rather than through DI: \`createAuthGatewayModule\` is invoked inside an
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
    path.join(PROTO_DIR, 'session_token.proto'),
    path.join(PROTO_DIR, 'mfa.proto'),
  ],
  url: process.env.IDENTITY_GRPC_URL ?? 'localhost:31001',
  addresses: {
    'identity.v1': process.env.IDENTITY_GRPC_URL ?? 'localhost:31001',
    'credential_vault.v1': process.env.CREDENTIAL_VAULT_GRPC_URL ?? 'localhost:31003',
    'session_token.v1': process.env.SESSION_TOKEN_GRPC_URL ?? 'localhost:31004',
    'mfa.v1': process.env.MFA_GRPC_URL ?? 'localhost:31006',
  },
});` : ''}

@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot('${service.serviceName}'),
${service.kafka ? `    // Supplies the Kafka consumer the notification module exports but does not
    // provide: the module is consumer-only and takes its transport from here.
    createKafkaModule(),` : ''}
    ${service.module}(${service.publisher || service.downstream ? `{ ${service.publisher ? 'publisher: eventPublisher' : ''}${service.publisher && service.downstream ? ', ' : ''}${service.downstream ? 'grpcChannel: downstreamChannel' : ''} }` : ''}),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
`,
  );

  writeFileSync(
    join(root, 'project.json'),
    `${JSON.stringify(
      {
        name: `@app/${service.dir}`,
        $schema: '../../node_modules/nx/schemas/project-schema.json',
        sourceRoot: `apps/${service.dir}/src`,
        projectType: 'application',
        tags: ['type:app'],
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

  writeFileSync(
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