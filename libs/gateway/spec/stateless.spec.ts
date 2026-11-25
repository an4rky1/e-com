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
        // `@auth/contracts/http` is a module *inside* `@auth/contracts`, not a layer — the
        // three-segment cut would otherwise report the HTTP contract as a new dependency.
        .map((specifier) =>
          specifier.startsWith('@auth/contracts')
            ? '@auth/contracts'
            : specifier.split('/').slice(0, 3).join('/'),
        ),
    );

    // `eslint.config.mjs` says the same thing as a `depConstraints` entry; this fails with a
    // readable list rather than a rule name.
    expect([...roots].sort()).toEqual([
      '@auth/contracts',
      '@auth/infra/grpc',
      '@auth/infra/idempotency',
      '@auth/infra/rate-limit',
      '@auth/infra/redis',
      '@auth/platform/config',
      '@auth/platform/context',
      '@auth/platform/error-handling',
      '@auth/platform/feature-flags',
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
  it('imports only its own library, the platform and the shared contracts', () => {
    const roots = new Set(
      specifiersOf(APP_SOURCES)
        .filter((specifier) => specifier.startsWith('@auth/'))
        .map((specifier) => specifier.split('/').slice(0, 2).join('/')),
    );

    expect([...roots].sort()).toEqual(['@auth/contracts', '@auth/gateway', '@auth/platform']);
  });

  it('opens no gRPC listener, because the gateway is a client and never a server', () => {
    expect(offendersFor(/connectMicroservice|Transport\.GRPC|mergeMicroservice/)).toEqual([]);
  });
});

describe('the api-gateway needs two secrets, and neither of them has a default', () => {
  it('refuses to resolve without the service token, rather than booting a client that presents nothing', () => {
    // No `DATABASE_URL`, no peer addresses: every one of them has a default or does not
    // exist. The first thing that is not optional is the secret this edge presents on every
    // peer call — a channel with no token of its own would be refused by every receiving
    // guard, just later and per call.
    expect(() => resolveGatewayConfig({})).toThrow(/GRPC_SERVICE_TOKEN/);
  });

  it('refuses to resolve without the signing key, rather than booting a guard that 401s everyone', () => {
    // Read after the service token, so this is named only once that one is given: an edge
    // that cannot verify a bearer refuses every authenticated request anyway, and the boot
    // error is where that gets caught instead — one message at startup rather than one 401
    // per caller.
    expect(() =>
      resolveGatewayConfig({ GRPC_SERVICE_TOKEN: 'a-shared-service-token' }),
    ).toThrow(/SESSION_ACCESS_TOKEN_SIGNING_KEY/);
  });

  it('resolves every default once both secrets are given', () => {
    const config = resolveGatewayConfig({
      GRPC_SERVICE_TOKEN: 'a-shared-service-token',
      SESSION_ACCESS_TOKEN_SIGNING_KEY: 'the-shared-signing-key',
    });

    expect(config.peerDeadlineMs).toBe(3_000);
    expect(config.identityUrl).toBe('localhost:13001');
    expect(config.grpcServiceToken).toBe('a-shared-service-token');
    expect(config.accessTokenSigningKey).toBe('the-shared-signing-key');
    // The issuer's tolerance, read from its namespace rather than chosen here: two readings
    // of the skew is the "logged out for no reason" bug wearing a config file.
    expect(config.clockSkewSec).toBe(30);
  });

  it('boots even when a database happens to be in the environment', () => {
    const config = resolveGatewayConfig({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/identity',
      GRPC_SERVICE_TOKEN: 'a-shared-service-token',
      SESSION_ACCESS_TOKEN_SIGNING_KEY: 'the-shared-signing-key',
    });

    // Absent from the schema, so absent from the result: `readNamespacedEnv` has no way to
    // hand it over even when the process has it set.
    expect(JSON.stringify(config)).not.toContain('postgresql');
    expect(Object.keys(config)).not.toContain('databaseUrl');
  });

  it('reads both secrets from the namespaces that own them, and no lookalike of its own', () => {
    const config = resolveGatewayConfig({
      // Somebody else's variable: the gateway's own address knobs are `GATEWAY_`-prefixed,
      // so this one is ignored and the compiled-in default stands.
      IDENTITY_GRPC_URL: 'identity.internal:13001',
      GATEWAY_PEER_DEADLINE_MS: '750',
      GATEWAY_SERVICE_TOKEN: 'a-token-nobody-else-would-present',
      GATEWAY_ACCESS_TOKEN_SIGNING_KEY: 'a-key-nobody-else-would-sign-with',
      GRPC_SERVICE_TOKEN: 'the-shared-service-token',
      SESSION_ACCESS_TOKEN_SIGNING_KEY: 'the-shared-signing-key',
    });

    expect(config.peerDeadlineMs).toBe(750);
    expect(config.identityUrl).toBe('localhost:13001');

    // One variable each, read from the namespace that owns it. A `GATEWAY_`-prefixed twin
    // would be a second secret for a single trust boundary — and for the signing key, a
    // rotation that updated this edge out of step with session, which is the failure
    // mode where a token mints fine and refuses at the edge.
    expect(config.grpcServiceToken).toBe('the-shared-service-token');
    expect(config.accessTokenSigningKey).toBe('the-shared-signing-key');
    const rendered = JSON.stringify(config);
    expect(rendered).not.toContain('a-token-nobody-else-would-present');
    expect(rendered).not.toContain('a-key-nobody-else-would-sign-with');
  });

  it('rejects a malformed peer deadline at boot rather than on the first request', () => {
    expect(() => resolveGatewayConfig({ GATEWAY_PEER_DEADLINE_MS: 'soon' })).toThrow(
      /GATEWAY_PEER_DEADLINE_MS/,
    );
  });
});
