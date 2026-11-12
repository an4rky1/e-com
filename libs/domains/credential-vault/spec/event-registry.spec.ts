/**
 * @fileoverview The classification contract for credential-vault: every event the aggregates
 * raise is an integration event with a contract topic.
 */

import { join } from 'node:path';
import { checkEventRegistry } from '@auth/testing';
import { CREDENTIAL_VAULT_EVENTS } from '../src/infrastructure/events/credential-vault.events';

describe('credential-vault event registry', () => {
  it('classifies every event the domain layer raises', () => {
    expect(
      checkEventRegistry(CREDENTIAL_VAULT_EVENTS, join(__dirname, '../src/domain')),
    ).toEqual({
      unclassified: [],
      uncoveredPrefixes: [],
      duplicated: [],
    });
  });
});
