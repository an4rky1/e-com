/**
 * @fileoverview Auth-flow's classification of its domain events.
 *
 * The flow *is* a cross-service sequence — account-security scores it, audit-log records it —
 * so every state transition it makes is integration. There is no internal event here, and the
 * completeness spec keeps that honest if one appears.
 */

import { Topics } from '@auth/contracts';
import type { EventRegistry } from '@auth/infra/events';

export const AUTH_FLOW_EVENTS: EventRegistry = {
  integration: {
    'auth_flow.started': { topic: Topics.AUTH_FLOW_STARTED },
    'auth_flow.step_completed': { topic: Topics.AUTH_FLOW_STEP_COMPLETED },
    'auth_flow.completed': { topic: Topics.AUTH_FLOW_COMPLETED },
    'auth_flow.failed': { topic: Topics.AUTH_FLOW_FAILED },
  },
  internal: [],
};
