/**
 * Shared Jest preset for every backend lib and app.
 *
 * Why the mapper is derived rather than hand-listed: the `@auth/*` aliases live in
 * `tsconfig.base.json`, and a second hand-maintained copy in each of 25 jest configs is
 * guaranteed to drift. Tests would then resolve a lib through a different path than the
 * compiler does, and failures would only show up under `ts-jest` isolation.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { paths } = JSON.parse(
  readFileSync(join(__dirname, 'tsconfig.base.json'), 'utf8'),
).compilerOptions;

const moduleNameMapper = Object.fromEntries(
  Object.entries(paths).map(([alias, [target]]) => [
    `^${alias.replace(/\*/g, '(.*)')}$`,
    join(__dirname, target.replace(/\*/g, '$1')),
  ]),
);

module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper,
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        // 151002: the backend uses Node16 module resolution, which ts-jest reports as a
        // "hybrid module kind". It is a notice about transpilation strategy, not a defect.
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  // The outbox, kafka consumer and grpc client all hold sockets. Letting them dangle
  // makes a passing suite print "did not exit one second after" warnings that mask real
  // leaks.
  forceExit: false,
  detectOpenHandles: false,
  // A lib with a `test` target but no specs yet is not a failure; it is an empty suite.
  // Without this, every freshly scaffolded lib reports red and buries real failures.
  passWithNoTests: true,
};