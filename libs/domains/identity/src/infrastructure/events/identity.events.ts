/**
 * @fileoverview Identity's classification of its domain events.
 *
 * Only the facts another service acts on leave the process: a registration that starts a
 * welcome mail, an email verification other services must stop challenging, a deletion every
 * cache and consumer must honour. Status transitions are identity's own bookkeeping — the
 * row is the truth and no other service may re-derive it — so they are named as internal
 * rather than left to be silently dropped.
 */

import { Topics } from '@auth/contracts';
import type { EventRegistry } from '@auth/infra/events';

export const IDENTITY_EVENTS: EventRegistry = {
  integration: {
    'user.registered': { topic: Topics.USER_REGISTERED },
    'user.email_verified': { topic: Topics.USER_EMAIL_VERIFIED },
    'user.deleted': { topic: Topics.USER_DELETED },
  },
  internal: ['user.activated', 'user.suspended', 'user.reactivated'],
};
