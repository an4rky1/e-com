/**
 * @fileoverview What this edge can still do.
 *
 * @remarks The question is about the channel, not about the peers. An edge whose channel has
 * shut down cannot reach anybody, so it is out of the load balancer immediately; whether
 * identity is *currently* answering is a different question, and one that belongs on the
 * route that needs identity, not on a probe every replica runs.
 */
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import { GRPC_CHANNEL, type GrpcChannel } from '@auth/infra/grpc';

@Injectable()
export class GatewayHealthIndicator extends HealthIndicator {
  constructor(@Inject(GRPC_CHANNEL) private readonly channel: GrpcChannel) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const state = this.channel.getState();
    const usable = state !== 'SHUTDOWN';

    return this.withStatus('api-gateway', usable, {
      state,
      // Stated plainly so an operator does not read "up" as "every peer answered": it means
      // this process can make a call, not that anybody picked up.
      dependency: 'peer channel state',
    });
  }
}
