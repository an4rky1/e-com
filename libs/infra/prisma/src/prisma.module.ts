import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaHealthIndicator } from './prisma.health';
import { PrismaService, type PrismaClientLike } from './prisma.service';

export const PRISMA_SERVICE = Symbol('PRISMA_SERVICE');
export const PRISMA_MODULE_ID = Symbol('PRISMA_MODULE_ID');

export interface PrismaModuleFactoryOptions {
  /**
   * The service's own generated client.
   *
   * @remarks Each service generates its Prisma client from its own schema. That is what
   * makes table ownership a compile-time guarantee rather than a convention: identity cannot
   * name a session row, because that model is absent from its client.
   */
  client: PrismaClientLike;
}

/**
 * Declared once at module scope: Nest identifies a dynamic module by class reference, so a
 * class literal created inside the factory would register a brand new module per call.
 */
@Module({})
class PrismaModule {}

/**
 * Builds the Prisma module for one service.
 *
 * @remarks `DATABASE_URL` is platform-owned and must point at this service's database only.
 */
export function createPrismaModule(options: PrismaModuleFactoryOptions): DynamicModule {
  return {
    module: PrismaModule,
    global: true,
    providers: [
      {
        provide: PRISMA_SERVICE,
        inject: [ConfigService],
        useFactory: (config: ConfigService) => {
          const databaseUrl = config.get<string>('DATABASE_URL');
          if (!databaseUrl) {
            // Refusing to boot is correct: a default URL would point every service at the
            // same local database and the first integration test would write to the wrong one.
            throw new Error('DATABASE_URL is required');
          }
          return new PrismaService(options.client, {
            logQueries: config.get('LOG_QUERIES') === 'true',
          });
        },
      },
      {
        provide: PrismaHealthIndicator,
        inject: [PRISMA_SERVICE],
        useFactory: (prisma: PrismaService<PrismaClientLike>) =>
          new PrismaHealthIndicator(prisma),
      },
    ],
    exports: [PRISMA_SERVICE, PrismaHealthIndicator],
  };
}