import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

/**
 * Platform configuration source.
 *
 * @remarks The platform owns deployment-level values (`DATABASE_URL`, `KAFKA_BROKERS`,
 * `REDIS_URL`, `SERVICE_NAME`). A module's own settings live under its namespace
 * (`IDENTITY_*`, `SESSION_*`) and are resolved by that module — a module reading
 * `process.env` directly has no declared configuration surface and cannot be tested.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Deliberately no `ignoreEnvFile`: each service reads `.env.<service>` and
      // `NODE_ENV`, so one shared root `.env` cannot silently reconfigure a service.
      envFilePath: ['.env.local', `.env.${process.env.SERVICE_NAME ?? 'default'}`],
    }),
  ],
  exports: [NestConfigModule],
})
export class PlatformConfigModule {}