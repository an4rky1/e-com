/**
 * @fileoverview The classification contract for auth-flow: every event the aggregate raises is
 * either an integration event with a contract topic or explicitly internal.
 */

import { join } from 'node:path';
import { checkEventRegistry } from '@auth/testing';
import { AUTH_FLOW_EVENTS } from '../src/infrastructure/events/auth-flow.events';

describe('auth-flow event registry', () => {
  it('classifies every event the domain layer raises', () => {
    expect(
      checkEventRegistry(AUTH_FLOW_EVENTS, join(__dirname, '../src/domain')),
    ).toEqual({
      unclassified: [],
      uncoveredPrefixes: [],
      duplicated: [],
    });
  });
});
