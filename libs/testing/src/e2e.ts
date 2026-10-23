/**
 * @fileoverview Helpers for booting a service in an integration or end-to-end test.
 *
 * @remarks The important property is isolation: each suite gets its own application instance
 * and, where a database is involved, a known-empty one. A test that inherits another suite's
 * rows fails in CI and passes locally, which is the worst possible failure mode.
 */

// Type-only: erased at compile time, so nothing here pulls Nest into the runtime module graph —
// the deferred `require`s below stay the only place that happens.
import type * as NestCommon from '@nestjs/common';
import type * as NestTesting from '@nestjs/testing';

export interface PrismaLike {
  $queryRawUnsafe(query: string): Promise<unknown>;
  $executeRawUnsafe(query: string): Promise<number>;
  $disconnect(): Promise<void>;
}

export interface BootstrapOptions {
  /**
   * Provider overrides.
   *
   * @remarks Everything with an external side effect belongs here — mail, Kafka, Redis, SMS.
   * A suite that silently talks to real infrastructure is flaky and, worse, can bill someone.
   */
  overrideProviders?: Array<{ provide: unknown; useValue: unknown }>;
  /** Applies the same global pipes and filters the real bootstrap uses. */
  applyGlobalValidation?: boolean;
}

export interface TestApp {
  httpServer: unknown;
  close(): Promise<void>;
  get<TProvider = unknown>(token: unknown): TProvider;
}

/**
 * Structural view of the Nest application this module drives.
 *
 * @remarks Declared structurally so the testing lib does not depend on `@nestjs/common`'s
 * concrete generics, which differ across Nest major versions.
 */
type NestApplication = {
  init(): Promise<unknown>;
  close(): Promise<void>;
  getHttpServer(): unknown;
  get<TProvider = unknown>(token: unknown): TProvider;
  useGlobalPipes(...pipes: unknown[]): unknown;
  useGlobalFilters(...filters: unknown[]): unknown;
  enableShutdownHooks(): unknown;
};

type TestModuleInput = NonNullable<
  Parameters<typeof NestTesting.Test.createTestingModule>[0]['imports']
>[number];

/**
 * Boots a Nest module for testing.
 *
 * @remarks `createNestApplication` is used deliberately rather than `createApplicationContext`:
 * these suites assert over HTTP, and a context-only app cannot route a request.
 */
export async function bootstrapE2E<TModule>(
  module: TModule,
  options: BootstrapOptions = {},
): Promise<TestApp> {
  const { Test } = require('@nestjs/testing') as typeof NestTesting;
  const { ValidationPipe } = require('@nestjs/common') as typeof NestCommon;

  const builder = Test.createTestingModule({
    imports: [module as TestModuleInput],
  });

  for (const override of options.overrideProviders ?? []) {
    builder.overrideProvider(override.provide).useValue(override.useValue);
  }

  const testingModule = await builder.compile();
  const app = testingModule.createNestApplication() as unknown as NestApplication;

  if (options.applyGlobalValidation !== false) {
    // `whitelist` strips unknown properties, so a typo'd field is rejected instead of being
    // silently ignored and leaving a default in place.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
  }

  await app.init();

  return {
    httpServer: app.getHttpServer(),
    close: () => app.close(),
    get: <TProvider = unknown>(token: unknown) => app.get<TProvider>(token),
  };
}

/**
 * Truncates every table in the test database.
 *
 * @remarks Postgres only. The table list is read from the live catalogue rather than a
 * hard-coded allow-list so a migration that adds a table cannot leave stale rows behind in CI.
 * `RESTART IDENTITY CASCADE` matters: a suite that starts from a non-zero sequence fails only
 * under load.
 */
export async function truncateAll(prisma: PrismaLike): Promise<void> {
  const tables = await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`,
  ) as Array<{ tablename: string }>;

  for (const { tablename } of tables) {
    // Identifier cannot be parameterised; it comes from the catalogue, not from user input.
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "${tablename}" RESTART IDENTITY CASCADE`,
    );
  }
}

/** Builds an `Authorization: Bearer` header. */
export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Builds an `X-API-Key` header for machine-authenticated suites. */
export function apiKeyHeader(key: string): Record<string, string> {
  return { 'X-API-Key': key };
}

/**
 * Polls `check` until it returns truthy or the budget expires.
 *
 * @remarks Eventual consistency is real: an outbox relay may take a poll interval to publish,
 * so asserting immediately after a write is a flaky test rather than a fast one.
 */
export async function waitFor<T>(
  check: () => Promise<T | undefined | null> | T | undefined | null,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;

  for (;;) {
    try {
      const result = await check();
      if (result !== undefined && result !== null) return result;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${options.description ? `: ${options.description}` : ''}`,
        { cause: lastError },
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}