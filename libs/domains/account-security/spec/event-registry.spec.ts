/**
 * @fileoverview The classification contract for account-security: every event the aggregates
 * raise is either an integration event with a contract topic or explicitly internal.
 *
 * @remarks The signal event type is assembled (`security.${signal.type}`), so the check also
 * requires the `security.` prefix to be covered — a registry that lost one of the three
 * signal routes fails here rather than at a consumer that stops receiving anomalies.
 */

import { join } from 'node:path';
import { Topics } from '@auth/contracts';
import { checkEventRegistry } from '@auth/testing';
import { ACCOUNT_SECURITY_EVENTS } from '../src/infrastructure/events/account-security.events';

describe('account-security event registry', () => {
  it('classifies every event the domain layer raises', () => {
    expect(
      checkEventRegistry(ACCOUNT_SECURITY_EVENTS, join(__dirname, '../src/domain')),
    ).toEqual({
      unclassified: [],
      uncoveredPrefixes: [],
      duplicated: [],
    });
  });

  it('routes each lock-lifecycle fact to its own topic', () => {
    expect(ACCOUNT_SECURITY_EVENTS.integration['account.locked']?.topic).toBe(
      Topics.USER_LOCKED,
    );
    expect(ACCOUNT_SECURITY_EVENTS.integration['account.unlocked']?.topic).toBe(
      Topics.USER_UNLOCKED,
    );
  });
});
