/**
 * @fileoverview The classification contract: every event identity's aggregates raise is
 * either an integration event with a contract topic or explicitly internal.
 *
 * @remarks This is the machine half of "all actions generate events". Adding an event class
 * without classifying it fails here rather than surfacing as a `warn` line nobody reads.
 */

import { join } from 'node:path';
import { checkEventRegistry } from '@auth/testing';
import { IDENTITY_EVENTS } from '../src/infrastructure/events/identity.events';

describe('identity event registry', () => {
  it('classifies every event the domain layer raises', () => {
    expect(
      checkEventRegistry(IDENTITY_EVENTS, join(__dirname, '../src/domain')),
    ).toEqual({
      unclassified: [],
      uncoveredPrefixes: [],
      duplicated: [],
    });
  });
});
