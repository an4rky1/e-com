import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nx from '@nx/eslint-plugin';

// ESM has no `__dirname`; the config is the workspace root's own file.
const ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Layer rules are enforced twice:
 *  1. NX dep constraints below police lib -> lib edges (platform/infra/domain/contracts).
 *  2. `no-restricted-imports` overrides police intra-lib edges, because all four clean
 *     architecture layers of a service live inside one lib (`libs/domains/<service>`) and
 *     are therefore invisible to NX tags.
 */
const NON_DOMAIN_TAGS = [
  'type:core',
  'type:contracts',
  'type:platform',
  'type:infra',
  'type:testing',
];

/**
 * Derived from the filesystem rather than hand-listed. A hand list rots silently: `api-key`
 * and `mfa` were missing from it, and for as long as nobody noticed those two services had
 * no cross-service boundary at all — any domain could import either of them. A new service
 * directory is now a new boundary, automatically.
 */
const DOMAINS = readdirSync(join(ROOT, 'libs/domains'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const domainTags = DOMAINS.map((d) => `domain:${d}`);

const depConstraints = [
  {
    // The kernel knows nothing about the application.
    sourceTag: 'type:core',
    onlyDependOnLibsWithTags: ['type:core'],
  },
  {
    // Contracts are pure types shared across service boundaries.
    sourceTag: 'type:contracts',
    onlyDependOnLibsWithTags: ['type:core', 'type:contracts'],
  },
  {
    // Platform services may only build on the kernel and each other.
    sourceTag: 'type:platform',
    onlyDependOnLibsWithTags: [
      'type:core',
      'type:contracts',
      'type:platform',
    ],
  },
  {
    // Infrastructure may use platform, but never reaches into a domain.
    sourceTag: 'type:infra',
    onlyDependOnLibsWithTags: [
      'type:core',
      'type:contracts',
      'type:platform',
      'type:infra',
    ],
  },
  {
    // A domain service composes everything below it.
    sourceTag: 'type:domain',
    onlyDependOnLibsWithTags: [
      'type:core',
      'type:contracts',
      'type:platform',
      'type:infra',
      'type:domain',
    ],
  },
  {
    // The edge is a proxy, not a participant. It may reach down to the kernel, the contracts
    // and the platform/infra plumbing, and nothing else — crucially not `type:domain`, so a
    // gateway can never import a service's internals and quietly become a second copy of it.
    // `type:gateway` is allowed so the api-gateway app can assemble the gateway lib itself.
    sourceTag: 'type:gateway',
    onlyDependOnLibsWithTags: [
      'type:core',
      'type:contracts',
      'type:platform',
      'type:infra',
      'type:gateway',
    ],
  },
  {
    sourceTag: 'type:testing',
    onlyDependOnLibsWithTags: ['*'],
  },
  {
    sourceTag: 'type:app',
    onlyDependOnLibsWithTags: ['*'],
  },
  {
    // The browser client speaks HTTP and nothing else. Its one library is the contract file
    // that describes that HTTP surface — never a service, never the gateway itself. The
    // file-scoped `no-restricted-imports` below says the same thing with a readable message;
    // this is the graph-level half of the same rule.
    sourceTag: 'type:web',
    onlyDependOnLibsWithTags: ['type:contracts'],
  },
  // Microservice boundary: services never import each other's internals.
  // Cross-service traffic goes through gRPC (question) or Kafka (fact).
  ...DOMAINS.map((domain) => ({
    sourceTag: `domain:${domain}`,
    onlyDependOnLibsWithTags: [
      'type:core',
      'type:contracts',
      'type:platform',
      'type:infra',
      'type:testing',
      `domain:${domain}`,
    ],
  })),
];

/** Packages the domain layer may never reach for. */
const DOMAIN_FORBIDDEN_IMPORTS = [
  {
    // Dependencies point down the layers only. Never up.
    group: ['**/infrastructure', '**/presentation', '**/apps/*'],
    message:
      'The domain layer is the innermost ring: it may not import infrastructure or presentation.',
  },
  {
    group: [
      '@nestjs/**',
      '@prisma/client',
      'ioredis',
      'kafkajs',
      '@grpc/**',
      'argon2',
      'typeorm',
      'mongoose',
    ],
    message:
      'The domain layer must stay framework-free: express intent through ports, implement them in infrastructure.',
  },
];

/** Packages the application layer may never reach for. */
const APPLICATION_FORBIDDEN_IMPORTS = [
  {
    group: ['**/presentation', '**/apps/*'],
    message:
      'The application layer owns use cases and must not know about HTTP controllers.',
  },
  {
    group: ['@prisma/client', 'ioredis', 'kafkajs'],
    message:
      'The application layer depends on domain ports only; talk to repositories and outbox through interfaces.',
  },
];

/** Packages the presentation layer may never reach for. */
const PRESENTATION_FORBIDDEN_IMPORTS = [
  {
    group: ['**/infrastructure', '**/apps/*'],
    message:
      'Controllers must call the application facade, never persistence or transport adapters.',
  },
];

/**
 * What the edge may never name.
 *
 * @remarks `depConstraints` above already refuses `type:gateway -> type:domain`. This is the
 * belt to that pair of braces: it also catches the relative-path spelling (`../../domains/
 * identity/src/...`), which is invisible to the tag check because it never becomes an `@auth/*`
 * alias, and it states the intent in the file that the next reader of the gateway will find.
 *
 * @remarks `DATABASE_URL` is forbidden for the same underlying reason. An edge that opens a
 * database is an edge that owns a second copy of somebody else's state.
 */
const GATEWAY_FORBIDDEN_IMPORTS = [
  {
    group: [
      '@auth/domains/**',
      '**/libs/domains/**',
      '@prisma/client',
      '**/generated/prisma/**',
      '@prisma/**',
      'ioredis',
      'kafkajs',
    ],
    message:
      'The api-gateway is a stateless edge: it owns no state and may not reach into a domain service, a database client or a broker.',
  },
  {
    // Relative paths are invisible to the tag check, because they never become an `@auth/*`
    // alias. A `../../domains/identity/src/...` import would sail past NX and land the edge
    // inside a service's aggregate.
    group: ['**/domains/*/src/**'],
    message:
      'Cross into a service only through its gRPC contract; a relative import past the boundary is the same violation wearing a different hat.',
  },
];

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/test-output',
      '**/generated/**',
      // Next.js build output: compiled chunks, not sources. Linting them floods the report
      // with `no-explicit-any` from minified bundles and buries real findings.
      '**/.next',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints,
        },
      ],
    },
  },
  // ---- Clean architecture enforcement inside a domain service lib ----
  {
    files: ['libs/domains/*/src/domain/**/*.ts'],
    rules: {
      // The entries are `patterns`, not top-level options: core `no-restricted-imports`
      // takes `{ paths, patterns }`, and a bare `{ group, message }` at the top level is a
      // schema error that makes ESLint refuse to start for every project in the workspace.
      'no-restricted-imports': ['error', { patterns: DOMAIN_FORBIDDEN_IMPORTS }],
    },
  },
  {
    files: ['libs/domains/*/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: APPLICATION_FORBIDDEN_IMPORTS }],
    },
  },
  {
    files: ['libs/domains/*/src/presentation/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: PRESENTATION_FORBIDDEN_IMPORTS }],
    },
  },
  // ---- Statelessness of the edge ----
  {
    files: ['libs/gateway/**/*.ts', 'apps/api-gateway/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: GATEWAY_FORBIDDEN_IMPORTS }],
    },
  },
  // ---- The web edge talks HTTP, not the backend's internals ----
  {
    files: ['apps/front/**/*.[jt]s', 'apps/front/**/*.[jt]sx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@auth/domains/**',
                '@auth/infra/**',
                '@auth/gateway',
                '@auth/platform/**',
                '@prisma/client',
                '**/generated/prisma/**',
              ],
              message:
                'The web app is a browser client: it reaches the backend over HTTP, never by importing a server-side layer.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts', '**/*.js', '**/*.jsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // ---- CLIs under tools/: stdout is their output stream ----
  // A harness script that reports a result with `console.log` is doing its job, not leaking
  // debug output — but the workspace-wide rule cannot tell one from the other, so the
  // exception is scoped to the directory where printing *is* the behaviour.
  {
    files: ['tools/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];

export { DOMAINS, domainTags, NON_DOMAIN_TAGS };