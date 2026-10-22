/**
 * @fileoverview Commands for the api key lifecycle, and the results they return.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a REST
 * field never reaches the domain.
 *
 * @remarks Classes, not interfaces. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is given. A
 * plain object literal or a `@CommandHandler('Name')` string therefore cannot dispatch at
 * all — the latter throws at import, because `Reflect.hasOwnMetadata` rejects a non-object.
 */
import { Command } from '@nestjs/cqrs';
import type { ApiKeyScope } from '../../domain/value-objects/api-key-scope.vo';

/**
 * A freshly issued key.
 *
 * @remarks `key` is the plaintext, and this object is the only place it ever exists after
 * issuance. Nothing else in the system may hold it: it is returned to the owner once, and
 * from then on the platform can only ever prove possession, never recover it.
 */
export interface CreatedApiKey {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly name: string;
  /** The non-secret, non-guessable handle shown in the dashboard. */
  readonly prefix: string;
  /** The plaintext. Shown once; never stored, never logged, never emitted as an event. */
  readonly key: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface RotatedApiKey extends CreatedApiKey {
  /** The key that stopped working in the same transaction. */
  readonly previousApiKeyId: string;
  readonly previousPrefix: string;
  readonly revokedAt: Date;
}

export interface RevokedApiKey {
  readonly apiKeyId: string;
  readonly userId: string;
  readonly reason: string;
  readonly revokedAt: Date;
  /** `false` when the key was already revoked and the call was a no-op. */
  readonly changed: boolean;
}

export class CreateApiKeyCommand extends Command<CreatedApiKey> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly name: string,
    readonly scopes?: readonly ApiKeyScope[],
    /** Absolute deadline; `null` means the key never expires on its own. */
    readonly expiresAt?: Date | null,
    /** Which key family to mint in: `live` in production, `test` everywhere else. */
    readonly family?: 'live' | 'test',
  ) {
    super();
  }
}

/** Thin constructor, so the facade and the transports cannot disagree about the shape. */
export const toCreateApiKeyCommand = (input: {
  userId: string;
  name: string;
  scopes?: readonly ApiKeyScope[];
  expiresAt?: Date | null;
  family?: 'live' | 'test';
}): CreateApiKeyCommand =>
  new CreateApiKeyCommand(
    input.userId,
    input.name,
    input.scopes,
    input.expiresAt,
    input.family,
  );

export class RotateApiKeyCommand extends Command<RotatedApiKey> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly apiKeyId: string,
    readonly family?: 'live' | 'test',
    /** Overrides the successor's deadline; `undefined` keeps the original's. */
    readonly expiresAt?: Date | null,
  ) {
    super();
  }
}

export class RevokeApiKeyCommand extends Command<RevokedApiKey> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly apiKeyId: string,
    readonly reason = 'revoked_by_owner',
    readonly userId?: string,
  ) {
    super();
  }
}