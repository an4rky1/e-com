/**
 * @fileoverview Account-security's classification of its domain events.
 *
 * Three signal topics and the two account-lifecycle topics. Locks ride on `USER_LOCKED` /
 * `USER_UNLOCKED` rather than the anomaly topic: audit-log and notification already subscribe
 * to them with dedicated routes, and folding them into `anomaly_detected` gave one fact two
 * possible templates depending on which topic happened to win.
 *
 * Partitioning is by **user**, not by attempt or signal id: two facts about the same account
 * must land on one partition or "locked" and "unlocked" reorder for every consumer.
 *
 * The login itself raises no event — the durable record of a login is the `login_history`
 * row, and the catalogue gives this service no "a login happened" topic. An attempt that
 * cannot name a user cannot produce an event at all: the aggregate refuses to lock without an
 * account to lock.
 */

import { Topics } from '@auth/contracts';
import type { IDomainEvent } from '@auth/core';
import type { EventRegistry } from '@auth/infra/events';

/** Every payload this service publishes carries the account it is about. */
const userIdOf = (event: IDomainEvent): string => {
  const userId = (event as { payload?: { userId?: unknown } }).payload?.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : event.aggregateId;
};

export const ACCOUNT_SECURITY_EVENTS: EventRegistry = {
  integration: {
    'security.new_device_detected': {
      topic: Topics.SECURITY_NEW_DEVICE_DETECTED,
      partitionKey: userIdOf,
    },
    'security.suspicious_login_detected': {
      topic: Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED,
      partitionKey: userIdOf,
    },
    'security.anomaly_detected': {
      topic: Topics.SECURITY_ANOMALY_DETECTED,
      partitionKey: userIdOf,
    },
    'account.locked': { topic: Topics.USER_LOCKED, partitionKey: userIdOf },
    'account.unlocked': { topic: Topics.USER_UNLOCKED, partitionKey: userIdOf },
  },
  internal: [],
};
