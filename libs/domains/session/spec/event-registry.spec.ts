/**
 * @fileoverview The classification contract for session: every event the aggregates raise is
 * either an integration event with a contract topic or explicitly internal.
 */

import { join } from 'node:path';
import { checkEventRegistry } from '@auth/testing';
import { SESSION_EVENTS } from '../src/infrastructure/events/session.events';

describe('session event registry', () => {
  it('classifies every event the domain layer raises', () => {
    expect(
      checkEventRegistry(SESSION_EVENTS, join(__dirname, '../src/domain')),
    ).toEqual({
      unclassified: [],
      uncoveredPrefixes: [],
      duplicated: [],
    });
  });
});
