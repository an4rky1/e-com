/**
 * Scaffolds the NX project boilerplate (project.json, tsconfigs, jest config) for every
 * lib in the workspace. Mechanical and identical, so it is generated rather than hand-copied
 * — a hand-copied jest config that drifts from its siblings is how half a workspace ends up
 * resolving modules differently from the other half.
 */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const LIBS = [
  ['core', ['type:core'], false],
  ['contracts', ['type:contracts'], false],

  ['platform/config', ['type:platform'], true],
  ['platform/api-versioning', ['type:platform'], true],
  ['platform/context', ['type:platform'], true],
  ['platform/error-handling', ['type:platform'], true],
  ['platform/feature-flags', ['type:platform'], true],
  ['platform/health', ['type:platform'], true],
  ['platform/shutdown', ['type:platform'], true],

  ['infra/prisma', ['type:infra'], true],
  ['infra/redis', ['type:infra'], true],
  ['infra/cache', ['type:infra'], true],
  ['infra/idempotency', ['type:infra'], true],
  ['infra/kafka', ['type:infra'], true],
  ['infra/outbox', ['type:infra'], true],
  ['infra/grpc', ['type:infra'], true],
  ['infra/queue', ['type:infra'], true],
  ['infra/rate-limit', ['type:infra'], true],

  ['domains/identity', ['type:domain', 'domain:identity'], true],
  ['domains/access-control', ['type:domain', 'domain:access-control'], true],
  ['domains/credential-vault', ['type:domain', 'domain:credential-vault'], true],
  ['domains/session', ['type:domain', 'domain:session'], true],
  ['domains/auth-flow', ['type:domain', 'domain:auth-flow'], true],
  ['domains/mfa', ['type:domain', 'domain:mfa'], true],
  ['domains/api-key', ['type:domain', 'domain:api-key'], true],
  ['domains/account-security', ['type:domain', 'domain:account-security'], true],
  ['domains/notification', ['type:domain', 'domain:notification'], true],
  ['domains/audit-log', ['type:domain', 'domain:audit-log'], true],

  ['testing', ['type:testing'], true],
];

/**
 * Path from a lib's directory back to the workspace root.
 * `libs/core` is two levels deep; `libs/platform/config` is three.
 */
const depth = (p) => (p.includes('/') ? '../../..' : '../..');

for (const [path, tags, withTests] of LIBS) {
  const root = join('libs', path);
  const name = path.split('/').pop();
  const up = depth(path);
  mkdirSync(join(root, 'src'), { recursive: true });

  const project = {
    name: `@auth/${path}`,
    $schema: '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot: `${root}/src`,
    projectType: 'library',
    tags,
    targets: {},
  };

  project.targets.typecheck = {
    executor: 'nx:run-commands',
    options: { command: `tsc -p ${root}/tsconfig.lib.json --noEmit` },
  };

  if (withTests) {
    project.targets.test = {
      executor: '@nx/jest:jest',
      outputs: [`{workspaceRoot}/coverage/${root}`],
      options: { jestConfig: `${root}/jest.config.ts` },
    };
  }

  writeFileSync(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

  writeFileSync(
    join(root, 'tsconfig.lib.json'),
    `{
  "extends": "${up}/tsconfig.backend.base.json",
  "compilerOptions": {
    "outDir": "${up}/dist/out-tsc",
    "declaration": false
  },
  "include": ["src/**/*.ts"]
}
`,
  );

  writeFileSync(
    join(root, 'tsconfig.spec.json'),
    `{
  "extends": "./tsconfig.lib.json",
  "compilerOptions": {
    "types": ["node", "jest"]
  },
  "include": ["src/**/*.ts", "spec/**/*.ts"]
}
`,
  );

  if (withTests) {
    writeFileSync(
      join(root, 'jest.config.ts'),
      `export default {
  displayName: '${name}',
  preset: '${up}/jest.backend.preset.js',
  rootDir: '.',
  coverageDirectory: '${up}/coverage/${root}',
};
`,
    );
  }
}

console.log(`scaffolded ${LIBS.length} libs`);