/**
 * Transport port used by the relay.
 *
 * @remarks Deliberately narrower than the producer: the relay needs to send one already
 * serialised payload, and nothing else. Keeping the surface small means a transport swap
 * (Kafka now, something else later) cannot break the relay.
 */
export interface EventPublisher {
  send(
    topic: string,
    payload: string,
    options: { partitionKey?: string; traceId?: string; eventId?: string },
  ): Promise<void>;
}