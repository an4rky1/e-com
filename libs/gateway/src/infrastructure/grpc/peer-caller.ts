/**
 * @fileoverview The one door every outbound call goes through.
 *
 * @remarks Two jobs, both of which have to happen together. A call gets a deadline, so a slow
 * peer cannot hold a browser's request open past the edge's own patience; and its failure is
 * translated, so a raw gRPC error object never reaches a handler that might put it in a body.
 *
 * @remarks Doing the translation here rather than in each of the five adapters is what makes
 * it a property of the edge instead of a habit. An adapter that forgot would still work
 * against a healthy peer, which is the kind of bug that passes every test written while the
 * dependency is up.
 */
import { Inject, Injectable } from '@nestjs/common';
import { GRPC_CHANNEL, type GrpcChannel } from '@auth/infra/grpc';
import { GATEWAY_CONFIG, type GatewayConfig } from '../../gateway.config';
import { translatePeerFailure } from './peer-errors';

@Injectable()
export class PeerCaller {
  constructor(
    @Inject(GRPC_CHANNEL) private readonly channel: GrpcChannel,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  /**
   * One unary call, bounded in time and translated on failure.
   *
   * @remarks The deadline is computed per call rather than reused: a deadline is an absolute
   * instant, so one captured at construction would already have expired by the time a request
   * arrived.
   */
  async call<TResponse>(method: string, request: object): Promise<TResponse> {
    try {
      return await this.channel.unary<object, TResponse>(method, request, {
        deadline: Date.now() + this.config.peerDeadlineMs,
      });
    } catch (error) {
      throw translatePeerFailure(error, method);
    }
  }

  /** Only the lifecycle hook; the channel itself is shared and process-scoped. */
  async close(): Promise<void> {
    await this.channel.close();
  }
}
