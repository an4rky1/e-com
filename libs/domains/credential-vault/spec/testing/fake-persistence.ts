/**
 * In-memory doubles for the credential-vault ports.
 *
 * @remarks Hand-written rather than generated, for two reasons. The repository holds real
 * aggregates rather than plain objects, so a test can assert on the events an aggregate
 * buffered without a database in the way; and the hasher is deliberately *observable* —
 * `hashes` and `equalised` record every call, which is what makes "did this path spend an
 * Argon2 budget on a user that does not exist?" a question a unit test can answer.
 */
import type {
  CredentialRepositoryPort,
  CredentialSpecification,
} from '../../src/domain/ports/credential-repository.port';
import {
  ARGON2_VERSION,
  type HashParameters,
  type PasswordHash,
  type PasswordHasherPort,
} from '../../src/domain/ports/password-hasher.port';
import { type PasswordCredential } from '../../src/domain/password-credential.aggregate';
import { type RecoveryCodeSet } from '../../src/domain/recovery-code-set.aggregate';
import type { IDomainEvent } from '@auth/core';

export const CURRENT_PARAMETERS: HashParameters = {
  algorithm: 'argon2id',
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  version: ARGON2_VERSION,
};

/** Marks a digest as fake, so a test can never mistake one for a real Argon2 string. */
export const DIGEST_PREFIX = 'fake-argon2id$';

/**
 * A reversible stand-in for Argon2.
 *
 * @remarks The digest embeds the password after a `|`, so `verify` can compare. A real hash
 * cannot do that — which is why the tests that care about the real thing
 * (`argon2-password.hasher.spec.ts`) exercise the native addon instead of this class.
 */
export class FakePasswordHasher implements PasswordHasherPort {
  readonly currentParameters: HashParameters = { ...CURRENT_PARAMETERS };
  readonly peppered = true;

  /** Every plaintext passed to `hash`, in call order. */
  readonly hashes: string[] = [];

  /** Every plaintext passed to `equaliseTiming`, in call order. */
  readonly equalised: string[] = [];

  async hash(password: string): Promise<PasswordHash> {
    this.hashes.push(password);
    return {
      digest: `${DIGEST_PREFIX}${this.hashes.length}|${password}`,
      parameters: { ...this.currentParameters },
    };
  }

  async verify(digest: string, password: string): Promise<boolean> {
    return digest.endsWith(`|${password}`);
  }

  async equaliseTiming(password: string): Promise<void> {
    this.equalised.push(password);
  }

  /** Same rule the real hasher uses: strictly below on any term means upgrade. */
  needsRehash(parameters: HashParameters): boolean {
    return (
      parameters.memoryCost < this.currentParameters.memoryCost ||
      parameters.timeCost < this.currentParameters.timeCost ||
      parameters.parallelism < this.currentParameters.parallelism ||
      parameters.hashLength < this.currentParameters.hashLength ||
      parameters.version < this.currentParameters.version
    );
  }

  /** Moves the "current policy", so an already-stored digest looks stale or fresh. */
  raisePolicy(overrides: Partial<HashParameters>): void {
    Object.assign(this.currentParameters, overrides);
  }
}

/** One row the repository would have written to `outbox_events`. */
export interface CapturedOutboxEvent {
  eventType: string;
  aggregateId: string;
  version: number;
  eventId: string;
  payload: unknown;
}

export class InMemoryCredentialRepository implements CredentialRepositoryPort {
  readonly credentials = new Map<string, PasswordCredential>();
  readonly recoveryCodeSets = new Map<string, RecoveryCodeSet>();

  readonly saved: PasswordCredential[] = [];
  readonly savedRecoveryCodeSets: RecoveryCodeSet[] = [];
  readonly deletedRecoveryCodeUsers: string[] = [];
  readonly outbox: CapturedOutboxEvent[] = [];

  constructor(seed: readonly PasswordCredential[] = []) {
    for (const credential of seed) {
      // A seeded credential stands for a row that is already in the database, so its events
      // have already been published. Clearing them keeps each test's assertions about "what
      // did *this* command announce".
      credential.clearDomainEvents();
      this.credentials.set(credential.id.value, credential);
    }
  }

  async save(credential: PasswordCredential): Promise<void> {
    this.saved.push(credential);
    this.credentials.set(credential.id.value, credential);
    this.capture(credential.id.value, credential.clearDomainEvents());
  }

  async saveAll(credentials: readonly PasswordCredential[]): Promise<void> {
    for (const credential of credentials) {
      await this.save(credential);
    }
  }

  async findByUser(
    userId: string,
    options: { includeRevoked?: boolean } = {},
  ): Promise<readonly PasswordCredential[]> {
    const rows = [...this.credentials.values()].filter(
      (credential) => credential.userId === userId,
    );
    return options.includeRevoked === false
      ? rows.filter((credential) => !credential.isRevoked())
      : rows;
  }

  async findPasswordCredential(
    userId: string,
    identifier?: string,
  ): Promise<PasswordCredential | null> {
    const match = [...this.credentials.values()].find(
      (credential) =>
        credential.userId === userId &&
        credential.method === 'password' &&
        (identifier === undefined || credential.identifier === identifier),
    );
    return match ?? null;
  }

  async findRecoveryCodeSet(userId: string): Promise<RecoveryCodeSet | null> {
    return this.recoveryCodeSets.get(userId) ?? null;
  }

  async saveRecoveryCodeSet(set: RecoveryCodeSet): Promise<void> {
    this.savedRecoveryCodeSets.push(set);
    this.recoveryCodeSets.set(set.id, set);
    this.capture(set.id, set.clearDomainEvents());
  }

  async deleteRecoveryCodes(userId: string): Promise<void> {
    this.deletedRecoveryCodeUsers.push(userId);
    this.recoveryCodeSets.delete(userId);
  }

  async revokeAllCredentials(input: {
    userId: string;
    reason: string;
    now?: Date;
  }): Promise<number> {
    const live = await this.findByUser(input.userId, { includeRevoked: false });
    for (const credential of live) {
      credential.revoke(input.reason, input.now);
    }
    await this.saveAll(live);
    await this.deleteRecoveryCodes(input.userId);
    return live.length;
  }

  async find(spec: CredentialSpecification): Promise<readonly PasswordCredential[]> {
    return [...this.credentials.values()].filter((credential) =>
      spec.isSatisfiedBy(credential),
    );
  }

  async count(spec: CredentialSpecification): Promise<number> {
    return (await this.find(spec)).length;
  }

  /** Mirrors the real repository: a save drains the buffer and hands the events to the outbox. */
  private capture(aggregateId: string, events: readonly IDomainEvent[]): void {
    for (const event of events) {
      this.outbox.push({
        eventType: event.eventType,
        aggregateId,
        version: event.version,
        eventId: event.eventId,
        payload: (event as { payload?: unknown }).payload ?? {},
      });
    }
  }
}

/** A config object built literally, so no test ever reads `process.env`. */
export const testVaultConfig = (
  overrides: Partial<{
    pepper: string | null;
    argon2: HashParameters;
    maxFailedAttempts: number;
    lockoutSec: number;
    recoveryCodeCount: number;
    minPasswordLength: number;
    allowRehash: boolean;
    defaultIdentifier: string;
  }> = {},
) => ({
  pepper: 'test-pepper' as string | null,
  argon2: { ...CURRENT_PARAMETERS } as HashParameters,
  maxFailedAttempts: 3,
  lockoutSec: 900,
  recoveryCodeCount: 5,
  minPasswordLength: 12,
  allowRehash: true,
  defaultIdentifier: 'password',
  ...overrides,
});