/**
 * @fileoverview Answers the one question this service exists for: "is this request carrying a
 * valid machine credential, and what may it do?"
 *
 * @remarks The lookup is one indexed read by prefix followed by one constant-time digest
 * comparison. The prefix is in the credential *and* in the `api_keys.prefix` unique index, which
 * is why authentication does not scan the table — and why the prefix carries its own entropy:
 * it is the one part of a key that has to be unguessable even though it is stored in the clear.
 *
 * @remarks Every refusal raises the same exception with the same message and no context. "No
 * such key", "wrong body for a real prefix", "revoked" and "expired" are four different facts
 * about the caller, and a caller who can tell them apart learns which prefixes exist. What is
 * refused is decided here; what is *said* is not.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InvalidCredentialsException } from '@auth/platform/error-handling';
import {
  API_KEY_CRYPTO,
  type ApiKeyCryptoPort,
} from '../../domain/ports/api-key-crypto.port';
import {
  API_KEY_REPOSITORY,
  type ApiKeyRepositoryPort,
} from '../../domain/ports/api-key-repository.port';
import { parseApiKey, type ApiKeyPrefix } from '../../domain/value-objects/api-key-prefix.vo';
import type { ApiKeyScope } from '../../domain/value-objects/api-key-scope.vo';
import { ApiKeySecret } from '../../domain/value-objects/api-key-secret.vo';
import { type ApiKeyStatus } from '../../domain/value-objects/api-key-status.vo';
import { API_KEY_CONFIG, type ApiKeyConfig } from '../../api-key.config';

/** The one message every refused key carries. */
export const INVALID_API_KEY_MESSAGE = 'invalid api key';

/** What a proven key grants. Attached to the request by the guard. */
export interface AuthenticatedApiKey {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly prefix: string;
  readonly family: ApiKeyPrefix;
  readonly scopes: readonly ApiKeyScope[];
  readonly status: ApiKeyStatus;
}

/**
 * The port the guard depends on.
 *
 * @remarks Narrower than the repository and the crypto port on purpose: `ApiKeyAuthGuard` is
 * imported by api-gateway, and it should be able to hold *one* thing — "hand me a key, get back
 * what it may do" — rather than a storage adapter and a hashing implementation.
 */
export interface ApiKeyVerifier {
  /** @throws {InvalidCredentialsException} for anything that is not a live, matching key. */
  authenticate(presentedKey: string): Promise<AuthenticatedApiKey>;
}

/** DI token for {@link ApiKeyVerifier}. A `Symbol`, so it cannot collide with another module's. */
export const API_KEY_VERIFIER = Symbol('API_KEY_VERIFIER');

@Injectable()
export class ApiKeyAuthenticationService implements ApiKeyVerifier {
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepositoryPort,
    @Inject(API_KEY_CRYPTO) private readonly crypto: ApiKeyCryptoPort,
    @Inject(API_KEY_CONFIG) private readonly config: ApiKeyConfig,
  ) {}

  async authenticate(presentedKey: string): Promise<AuthenticatedApiKey> {
    const presented = this.read(presentedKey);
    const parsed = parseApiKey(presented);
    if (!parsed) {
      // Malformed before it was ever looked up: no digest, no database round trip, and the
      // same answer as a well-formed key that does not exist.
      throw new InvalidCredentialsException(INVALID_API_KEY_MESSAGE, {});
    }

    const key = await this.keys.findByPrefix(parsed.prefix);
    if (!key) {
      throw new InvalidCredentialsException(INVALID_API_KEY_MESSAGE, {});
    }

    // The prefix only found the row. This is the check: a caller holding a real prefix and a
    // wrong body fails here, which is why the prefix is treated as non-secret but unguessable.
    if (!this.crypto.verifyKey(presented, key.secretHash)) {
      throw new InvalidCredentialsException(INVALID_API_KEY_MESSAGE, {});
    }

    if (this.isRefusedFamily(key.family)) {
      throw new InvalidCredentialsException(INVALID_API_KEY_MESSAGE, {});
    }

    const now = new Date();
    if (!key.isUsableAt(now)) {
      throw new InvalidCredentialsException(INVALID_API_KEY_MESSAGE, {});
    }

    if (this.config.trackLastUsed) {
      // No event: "this key still works" is not a fact any consumer needs, and one event per
      // authenticated request would bury `api_key.revoked` in noise.
      key.markUsed(now);
      await this.keys.save(key);
    }

    return {
      apiKeyId: key.id.value,
      userId: key.userId,
      prefix: key.prefix,
      family: key.family,
      scopes: key.scopes,
      status: key.status,
    };
  }

  /** The format check, kept separate so every refusal below it can use one message. */
  private read(presentedKey: string): string {
    const parsed = ApiKeySecret.tryCreate(presentedKey);

    if (parsed.isFailure) {
      throw new InvalidCredentialsException(INVALID_API_KEY_MESSAGE, {});
    }

    return parsed.unwrapOrThrow().value;
  }

  /**
   * Whether a key of this family may authenticate here.
   *
   * @remarks Asymmetric on purpose. A `live` deployment refuses `test` keys outright: a
   * staging credential pasted into production must fail, and the family travels inside the key
   * precisely so the caller cannot relabel it. The reverse is left open because a `test`
   * deployment accepting a live key costs a staging box nothing, whereas a `live` deployment
   * accepting one costs an incident.
   */
  private isRefusedFamily(family: ApiKeyPrefix): boolean {
    return this.config.keyFamily === 'live' && family === 'test';
  }
}