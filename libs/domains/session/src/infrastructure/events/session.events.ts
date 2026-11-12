/**
 * @fileoverview Session's classification of its domain events.
 *
 * Every session fact is something another service already acts on — a login to announce, a
 * rotation that ends a chain, a revocation every cached decision must outlive, a reuse that
 * means a token was stolen — so the whole set is integration. Nothing here is internal, and
 * the completeness spec keeps it that way until a genuinely local fact appears.
 */

import { Topics } from '@auth/contracts';
import type { EventRegistry } from '@auth/infra/events';

export const SESSION_EVENTS: EventRegistry = {
  integration: {
    'session.issued': { topic: Topics.SESSION_ISSUED },
    'session.refreshed': { topic: Topics.SESSION_REFRESHED },
    'session.revoked': { topic: Topics.SESSION_REVOKED },
    'session.token_reuse_detected': { topic: Topics.SESSION_REUSE_DETECTED },
  },
  internal: [],
};
