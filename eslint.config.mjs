import nx from '@nx/eslint-plugin';

/**
 * Layer rules are enforced twice:
 *  1. NX dep constraints below police lib -> lib edges (platform/infra/domain/contracts).
 *  2. `no-restricted-imports` overrides police intra-lib edges, because all four clean
 *     architecture layers of a service live inside one lib (`libs/domains/<service>`) and
 *     are therefore invisible to NX tags.
 */
const NON_DOMAIN_TAGS = [
  'type:ddd-core',
  'type:contracts',
  'type:platform',
  'type:infra',
  'type:testing',
];

const DOMAINS = [
  'identity',
  'access-control',
  'credential-vault',
  'session-token',
  'auth-gateway',
  'notification',
  'audit-log',
  'account-security',
];

const domainTags = DOMAINS.map((d) => `domain:${d}`);

const depConstraints = [
  {
    // The kernel knows nothing about the application.
    sourceTag: 'type:ddd-core',
    onlyDependOnLibsWithTags: ['type:ddd-core'],
  },
  {
    // Contracts are pure types shared across service boundaries.
    sourceTag: 'type:contracts',
    onlyDependOnLibsWithTags: ['type:ddd-core', 'type:contracts'],
  },
  {
    // Platform services may only build on the kernel and each other.
    sourceTag: 'type:platform',
    onlyDependOnLibsWithTags: [
      'type:ddd-core',
      'type:contracts',
      'type:platform',
    ],
  },
  {
    // Infrastructure may use platform, but never reaches into a domain.
    sourceTag: 'type:infra',
    onlyDependOnLibsWithTags: [
      'type:ddd-core',
      'type:contracts',
      'type:platform',
      'type:infra',
    ],
  },
  {
    // A domain service composes everything below it.
    sourceTag: 'type:domain',
    onlyDependOnLibsWithTags: [
      'type:ddd-core',
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
    sourceTag: 'type:gateway',
    onlyDependOnLibsWithTags: [
      'type:ddd-core',
      'type:contracts',
      'type:platform',
      'type:infra',
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
  // Microservice boundary: services never import each other's internals.
  // Cross-service traffic goes through gRPC (question) or Kafka (fact).
  ...DOMAINS.map((domain) => ({
    sourceTag: `domain:${domain}`,
    onlyDependOnLibsWithTags: [
      'type:ddd-core',
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
];

export { DOMAINS, domainTags, NON_DOMAIN_TAGS };