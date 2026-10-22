/**
 * @fileoverview Composition root for the api-gateway.
 *
 * @remarks Imports the edge from `libs/gateway` rather than declaring providers here. The
 * gateway's own module brings its channel, its five peer adapters and `/health` with it —
 * this file's entire job is to say "this process is the public entry point".
 *
 * @remarks No `createKafkaPublisher()`. Every other app has one; this one has nothing to
 * publish, because it owns no state and therefore has nothing to announce a change to.
 */
import { Module } from '@nestjs/common';
import { PlatformConfigModule } from '@auth/platform/config';
import { ErrorHandlingModule } from '@auth/platform/error-handling';

import { ShutdownService } from '@auth/platform/shutdown';
import { createGatewayModule } from '@auth/gateway';

@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),

    createGatewayModule(),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
