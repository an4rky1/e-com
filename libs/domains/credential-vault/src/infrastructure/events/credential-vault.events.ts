/**
 * @fileoverview Credential-vault's classification of its domain events.
 *
 * Four credential facts and the recovery-code regeneration, all on their own contract topics.
 * `credential.revoked` rides on the rotation topic deliberately: the catalogue gives this
 * service four topics and none of them is a revocation; every one of these events says the
 * same thing to a consumer — whatever secret this credential held, it does not hold it now —
 * and the payload's `rotation`/`reason` fields say which. A fifth topic would mean a second
 * subscription for a fact that already has one.
 *
 * Partitioning is by **user**, not by credential id: two credentials of one account have to
 * land on the same partition or a consumer cannot order them. Every payload this domain
 * raises carries the owning user, so the key is read from the event rather than threaded
 * through the repository.
 */

import { Topics } from '@auth/contracts';
import type { IDomainEvent } from '@auth/core';
import type { EventRegistry } from '@auth/infra/events';

/** Every payload this service publishes carries the account it is about. */
const userIdOf = (event: IDomainEvent): string => {
  const userId = (event as { payload?: { userId?: unknown } }).payload?.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : event.aggregateId;
};

export const CREDENTIAL_VAULT_EVENTS: EventRegistry = {
  integration: {
    'credential.verified': {
      topic: Topics.CREDENTIAL_VERIFIED,
      partitionKey: userIdOf,
    },
    'credential.failed': {
      topic: Topics.CREDENTIAL_FAILED,
      partitionKey: userIdOf,
    },
    'credential.rotated': {
      topic: Topics.CREDENTIAL_ROTATED,
      partitionKey: userIdOf,
    },
    'credential.revoked': {
      topic: Topics.CREDENTIAL_ROTATED,
      partitionKey: userIdOf,
    },
    'credential.recovery_codes_regenerated': {
      topic: Topics.CREDENTIAL_RECOVERY_CODES_REGENERATED,
      partitionKey: userIdOf,
    },
  },
  internal: [],
};
