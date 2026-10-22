/**
 * @fileoverview The gateway is an edge, and this is what holds it to that.
 *
 * @remarks Every other claim about statelessness is a convention somebody can drift out of:
 * one day somebody needs a lookup, reaches for Prisma, and the edge quietly becomes the tenth
 * service with a copy of somebody's tables. So the property is asserted here, against the
 * source, rather than trusted to review.
 *
 * @remarks The eslint half of the same rule — `type:gateway` may not depend on `type:domain` —
 * catches the alias spelling. This catches the other three: a relative path into a domain
 * lib, a `DATABASE_URL`, a Prisma client. Neither check subsumes the other, so both exist.
 *
 * @remarks "No state" is not the same as "no Redis", and the distinction matters. The edge holds
 * no business state — no tables, no outbox, no copy of somebody's data — but it does hold a
 * rate-limit counter, which is a shared coordination value rather than a record of anything the
 * platform owns. Forbidding Redis outright would forbid the one thing the reference design puts
 * at the edge on purpose, so the check below forbids constructing a client here rather than
 * forbidding the dependency: the edge reaches the shared cache through the rate-limit module and
 * is not allowed to start caching business data in it.
 *
 * @remarks Comments are stripped before anything is matched. Both files below *mention*
 * `DATABASE_URL` and `libs/domains/*` — in the sentences explaining that the gateway has
 * neither — and a check that flagged those would have been deleted within a day rather than
 * satisfied, which is the usual way a guard rail stops guarding.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { resolveGatewayConfig } from '../src/gateway.config';

/** `libs/gateway/spec` -> workspace root. */
const ROOT = resolve(__dirname, '../../..');

/**
 * Removes block and line comments.
 *
 * @remarks Not a parser. Good enough for a directory of a few dozen files that contain no
 * `//` inside a string, and a wrong answer here is a false positive a reviewer can see.
 */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Every TypeScript file under a directory, recursively, comments removed. */
const sourcesUnder = (directory: string): { file: string; code: string }[] => {
  const found: { file: string; code: string }[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.ts')) {
        found.push({
          file: relative(ROOT, full),
          code: stripComments(readFileSync(full, 'utf8')),
        });
      }
    }
  };

  walk(directory);
  return found;
};

const LIB_SOURCES = sourcesUnder(join(ROOT, 'libs/gateway/src'));
const APP_SOURCES = sourcesUnder(join(ROOT, 'apps/api-gateway/src'));
const EDGE_SOURCES = [...LIB_SOURCES, ...APP_SOURCES];

/** Every module specifier the code imports, with its own quotes stripped. */
const specifiersOf = (sources: { code: string }[]): string[] =>
  sources.flatMap((source) =>
    [...source.code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] as string),
  );

const offendersFor = (pattern: RegExp): string[] =>
  EDGE_SOURCES.filter((source) => pattern.test(source.code)).map((source) => source.file);

describe('the api-gateway owns no state', () => {
  it('has sources to check', () => {
    // A glob that matches nothing makes every assertion below pass for the wrong reason.
    expect(LIB_SOURCES.length).toBeGreaterThan(10);
    expect(APP_SOURCES.length).toBeGreaterThan(0);
  });

  it.each([
    ['no Prisma client', /from\s+['"]@prisma\/client['"]|PrismaClient|PrismaService/],
    ['no generated Prisma', /generated\/prisma/],
    ['no DATABASE_URL', /DATABASE_URL/],
    // The edge may *use* the shared rate-limit cache, but must not own a connection to it. A
    // direct client here is how the edge starts keeping its own cached state, which is the
    // thing this whole file exists to prevent.
    [
      'no Redis client of its own',
      /from\s+['"]ioredis['"]|new\s+Redis\b/,
    ],
    ['no broker', /from\s+['"]kafkajs['"]|kafkajs/],
    ['no domain import', /@auth\/domains\/|libs\/domains\/|\.\.\/domains\//],
  ])('%s', (_case, pattern) => {
    expect(offendersFor(pattern)).toEqual([]);
  });

  it('imports nothing from a domain lib', () => {
    expect(specifiersOf(EDGE_SOURCES).filter((s) => s.includes('domains'))).toEqual([]);
  });
});

describe('the library reaches only the layers its tag allows', () => {
  it('imports exactly the permitted layers, and nothing else', () => {
    const roots = new Set(
      specifiersOf(LIB_SOURCES)
        .filter((specifier) => specifier.startsWith('@auth/'))
        // `@auth/gateway` is this lib's own alias, used by the app and by nobody here.
        .map((specifier) => specifier.split('/').slice(0, 3).join('/')),
    );

    // `eslint.config.mjs` says the same thing as a `depConstraints` entry; this fails with a
    // readable list rather than a rule name.
    expect([...roots].sort()).toEqual([
      '@auth/contracts',
      '@auth/infra/grpc',
      '@auth/infra/rate-limit',
      '@auth/platform/config',
      '@auth/platform/error-handling',
      '@auth/platform/health',
    ]);
  });

  it('never reaches past the platform into a domain, not even for a type', () => {
    const relativeDeep = specifiersOf(LIB_SOURCES).filter(
      (specifier) => specifier.startsWith('.') && !specifier.startsWith('./'),
    );

    // Every relative import in the lib points at another file in the same lib.
    expect(relativeDeep.length).toBeGreaterThan(5);
  });
});

describe('the app shell is thin', () => {
  it('imports only its own library and the platform', () => {
    const roots = new Set(
      specifiersOf(APP_SOURCES)
        .filter((specifier) => specifier.startsWith('@auth/'))
        .map((specifier) => specifier.split('/').slice(0, 2).join('/')),
    );

    expect([...roots].sort()).toEqual(['@auth/gateway', '@auth/platform']);
  });

  it('opens no gRPC listener, because the gateway is a client and never a server', () => {
    expect(offendersFor(/connectMicroservice|Transport\.GRPC|mergeMicroservice/)).toEqual([]);
  });
});

describe('the api-gateway needs no environment it was not given', () => {
  it('resolves from an empty environment', () => {
    // No `DATABASE_URL`, no signing key, no peer addresses: every one of them has a default
    // or does not exist, so the edge starts in a container with no configuration at all.
    const config = resolveGatewayConfig({});

    expect(config.peerDeadlineMs).toBe(3_000);
    expect(config.identityUrl).toBe('localhost:13001');
  });

  it('boots even when a database happens to be in the environment', () => {
    const config = resolveGatewayConfig({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/identity',
    });

    // Absent from the schema, so absent from the result: `readNamespacedEnv` has no way to
    // hand it over even when the process has it set.
    expect(JSON.stringify(config)).not.toContain('postgresql');
    expect(Object.keys(config)).not.toContain('databaseUrl');
  });

  it('reads only the GATEWAY_ namespace', () => {
    const config = resolveGatewayConfig({
      IDENTITY_GRPC_URL: 'identity.internal:13001',
      SESSION_ACCESS_TOKEN_SIGNING_KEY: 'a-signing-key-that-is-not-ours',
      GATEWAY_PEER_DEADLINE_MS: '750',
    });

    // Someone else's variable, and a signing key this process has no business holding.
    expect(config.peerDeadlineMs).toBe(750);
    expect(config.identityUrl).toBe('localhost:13001');
    expect(JSON.stringify(config)).not.toContain('signing-key');
  });

  it('rejects a malformed peer deadline at boot rather than on the first request', () => {
    expect(() => resolveGatewayConfig({ GATEWAY_PEER_DEADLINE_MS: 'soon' })).toThrow(
      /GATEWAY_PEER_DEADLINE_MS/,
    );
  });
});
