import { HealthIndicator } from '@auth/platform/health';
import type { KafkaProducerService } from './kafka.service';

export class KafkaHealthIndicator extends HealthIndicator {
  constructor(private readonly producer: KafkaProducerService) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    try {
      // A broker that is merely lagging is not a reason to pull the pod out of rotation —
      // events are buffered in the outbox. Only a producer that cannot connect is `down`.
      await this.producer.send('__healthcheck__', JSON.stringify({ ping: true }));
      return this.withStatus('kafka', true);
    } catch (error) {
      return this.withStatus('kafka', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}