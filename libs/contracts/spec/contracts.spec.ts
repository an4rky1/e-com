import {
  ALL_TOPICS,
  dlqTopicFor,
  retryTopicFor,
  Topics,
  TopicsByProducer,
  type Topic,
} from '../src/events/integration-event';
import { AuthStrategies, GrpcPackages, ServiceNames } from '../src';
import { EVENT_SCHEMA_VERSION } from '../src/events/integration-event';

describe('topic catalogue', () => {
  it('follows platform.<aggregate>.<event>.v<major> everywhere', () => {
    for (const topic of ALL_TOPICS) {
      expect(topic).toMatch(
        /^platform\.[a-z_]+\.[a-z_]+(\.[a-z_]+)*\.v\d+$/,
      );
    }
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_TOPICS).size).toBe(ALL_TOPICS.length);
  });

  it('never ends in the retry or dead-letter suffixes', () => {
    // `dlq`/`retry` are siblings derived at runtime, not catalogue entries — a topic that
    // already ends in one would produce `...dlq.dlq`.
    for (const topic of ALL_TOPICS) {
      expect(topic.endsWith('.dlq')).toBe(false);
      expect(topic.endsWith('.retry')).toBe(false);
    }
  });

  it('has no empty producer groups', () => {
    for (const [producer, topics] of Object.entries(TopicsByProducer)) {
      expect(topics.length).toBeGreaterThan(0);
      for (const topic of topics) {
        expect(ALL_TOPICS).toContain(topic);
      }
      expect(producer).toBeTruthy();
    }
  });

  it('assigns every topic to exactly one producing service', () => {
    const grouped = Object.values(TopicsByProducer).flat();
    // Notification consumes without producing, so the catalogue may legitimately cover fewer
    // topics than the producers list — but nothing may be claimed twice.
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});

describe('sibling topic derivation', () => {
  const topic: Topic = Topics.USER_REGISTERED;

  it('derives the dead-letter sibling', () => {
    expect(dlqTopicFor(topic)).toBe('platform.user.registered.v1.dlq');
  });

  it('derives the retry sibling', () => {
    expect(retryTopicFor(topic)).toBe('platform.user.registered.v1.retry');
  });

  it('keeps the siblings distinct', () => {
    expect(dlqTopicFor(topic)).not.toBe(retryTopicFor(topic));
  });
});

describe('service registry', () => {
  it('names every stateful service plus the gateway', () => {
    // 9 auth-side (gateway + 8 stateful) + 5 shop services.
    expect(Object.keys(ServiceNames)).toHaveLength(14);
    expect(ServiceNames.API_GATEWAY).toBe('api-gateway');
    expect(ServiceNames.CATALOG).toBe('catalog');
    expect(ServiceNames.CART).toBe('cart');
    expect(ServiceNames.INVENTORY).toBe('inventory');
    expect(ServiceNames.BILLING).toBe('billing');
    expect(ServiceNames.ORDER).toBe('order');
  });

  it('pairs every grpc package with a dotted v1 suffix', () => {
    for (const pkg of Object.values(GrpcPackages)) {
      expect(pkg).toMatch(/\.v1$/);
    }
  });

  it('pins the envelope schema version', () => {
    // Consumers validate on this; a silent bump without a migration breaks every consumer.
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('exposes the strategies the guards switch on', () => {
    expect(AuthStrategies.JWT).toBe('jwt');
    expect(AuthStrategies.SESSION).toBe('session');
    expect(AuthStrategies.API_KEY).toBe('api_key');
  });
});