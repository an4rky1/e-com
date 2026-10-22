/**
 * @fileoverview The command handlers, end to end, with no Nest bootstrap and no database.
 *
 * @remarks Handlers are constructed directly and the ports are the in-memory doubles from
 * `support/fakes`. That is possible only because the aggregate takes a clock, an engine and a
 * policy as arguments and the handlers take ports — the shape of the application layer is
 * what makes the replay path testable without a database.
 *
 * @remarks The production adapters are used throughout (`NodeTotpService`,
 * `AesGcmSecretVault`, `NodeRecoveryCodeService`). A stub that agreed with whatever the
 * aggregate did would prove nothing; these are the implementations that will run in
 * production, and the repository doubles store *rehydrated* copies so what a second request
 * loads is what the first one wrote.
 */

import 'reflect-metadata';
import {
  BeginEnrollmentHandler,
  ConfirmEnrollmentHandler,
  DisableMfaHandler,
  RegenerateRecoveryCodesHandler,
  VerifyFactorHandler,
} from '../src/application/commands/mfa.handlers';
import { GetMfaStatusHandler } from '../src/application/queries/mfa.queries';
import {
  BeginEnrollmentCommand,
  ConfirmEnrollmentCommand,
  DisableMfaCommand,
  RegenerateRecoveryCodesCommand,
  VerifyFactorCommand,
} from '../src/application/commands/mfa.commands';
import { GetMfaStatusQuery } from '../src/application/queries/mfa.queries';
import { toPolicy } from '../src/mfa.config';
import { TOTP_CODE_PATTERN } from '../src/domain/value-objects/mfa-method.vo';
import {
  InMemoryFactorRepository,
  InMemoryRecoverySetRepository,
  OTHER_USER_ID,
  RecordingUnitOfWork,
  T0,
  USER_ID,
  makeClock,
  makeCodes,
  makeTotp,
  makeVault,
  testConfig,
} from './support/fakes';

const totp = makeTotp();
const vault = makeVault();
const codes = makeCodes();
const config = testConfig();

function harness() {
  const factors = new InMemoryFactorRepository();
  const sets = new InMemoryRecoverySetRepository();
  const uow = new RecordingUnitOfWork();
  const clock = makeClock(T0);

  return {
    factors,
    sets,
    uow,
    clock,
    begin: new BeginEnrollmentHandler(factors, uow, totp, vault, clock, config),
    confirm: new ConfirmEnrollmentHandler(factors, uow, totp, vault, clock, config),
    verify: new VerifyFactorHandler(factors, sets, codes, uow, totp, vault, clock, config),
    disable: new DisableMfaHandler(factors, uow, totp, vault, clock, config),
    regenerate: new RegenerateRecoveryCodesHandler(sets, codes, uow, clock, config),
    status: new GetMfaStatusHandler(factors, sets),
  };
}

/** Enrols and confirms a factor, returning the bundle that still holds the plaintext secret. */
const enrolled = async (h: ReturnType<typeof harness>) => {
  const bundle = await h.begin.execute(new BeginEnrollmentCommand(USER_ID, 'totp', 'Pixel 8'));
  const code = totp.currentCode(bundle.secret, T0);
  const factor = await h.confirm.execute(
    new ConfirmEnrollmentCommand(USER_ID, bundle.factorId, code),
  );
  return { bundle, factor };
};

describe('BeginEnrollment', () => {
  it('issues a secret the caller can use, and stores only an envelope', async () => {
    const h = harness();

    const bundle = await h.begin.execute(new BeginEnrollmentCommand(USER_ID, 'totp', 'Pixel 8'));

    expect(bundle.method).toBe('totp');
    expect(bundle.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(bundle.otpauthUri).toContain('otpauth://totp/');
    expect(bundle.otpauthUri).toContain(encodeURIComponent(bundle.secret));
    expect(bundle.otpauthUri).toContain('digits=6');
    expect(bundle.otpauthUri).toContain('period=30');
    expect(new Date(bundle.expiresAt).getTime()).toBeGreaterThan(T0.getTime());

    const stored = h.factors.rows.get(bundle.factorId);
    expect(stored?.status).toBe('pending');
    // The candidate envelope lives in the pending column until a code confirms it; the
    // confirmed column stays empty, because a pending factor has no active secret.
    expect(stored?.secret_ciphertext).toBeNull();
    expect(stored?.pending_secret_value).not.toBe(bundle.secret);
    expect(await vault.decrypt(stored?.pending_secret_value as string)).toBe(bundle.secret);
    expect(stored?.totp_used_counters ?? null).toBeNull();
  });

  it('refuses a second live factor for the same method', async () => {
    const h = harness();
    await h.begin.execute(new BeginEnrollmentCommand(USER_ID));

    await expect(h.begin.execute(new BeginEnrollmentCommand(USER_ID))).rejects.toThrow(
      /unfinished or active factor/,
    );
  });

  it('refuses to enroll a method that is not a factor', async () => {
    const h = harness();

    await expect(
      h.begin.execute(new BeginEnrollmentCommand(USER_ID, 'backup_code')),
    ).rejects.toThrow(/not enrollable/);
  });
});

describe('ConfirmEnrollment', () => {
  it('activates the factor and clears the pending envelope', async () => {
    const h = harness();
    const bundle = await h.begin.execute(new BeginEnrollmentCommand(USER_ID));
    const code = totp.currentCode(bundle.secret, T0);

    const summary = await h.confirm.execute(
      new ConfirmEnrollmentCommand(USER_ID, bundle.factorId, code),
    );

    expect(summary.status).toBe('active');
    expect(summary.activatedAt).toBe(T0.toISOString());
    const stored = h.factors.rows.get(bundle.factorId);
    expect(stored?.pending_secret_value).toBeNull();
    expect(stored?.pending_secret_kind).toBeNull();
  });

  it('refuses a wrong code, leaves the factor pending, and counts the attempt', async () => {
    const h = harness();
    const bundle = await h.begin.execute(new BeginEnrollmentCommand(USER_ID));

    await expect(
      h.confirm.execute(new ConfirmEnrollmentCommand(USER_ID, bundle.factorId, '000000')),
    ).rejects.toThrow();

    const stored = h.factors.rows.get(bundle.factorId);
    expect(stored?.status).toBe('pending');
    expect(stored?.secret_ciphertext).toBeNull();
    // Counted outside the transaction that rolled back — otherwise the count would be free.
    expect(stored?.failed_attempts).toBe(1);
  });

  it('refuses a factor belonging to somebody else', async () => {
    const h = harness();
    const bundle = await h.begin.execute(new BeginEnrollmentCommand(USER_ID));

    await expect(
      h.confirm.execute(
        new ConfirmEnrollmentCommand(
          OTHER_USER_ID,
          bundle.factorId,
          totp.currentCode(bundle.secret, T0),
        ),
      ),
    ).rejects.toThrow(/no such factor/);
  });
});

describe('VerifyFactor — TOTP', () => {
  it('accepts the current code and spends its step', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);

    h.clock.advance(30_000);
    const result = await h.verify.execute(
      new VerifyFactorCommand(USER_ID, totp.currentCode(bundle.secret, h.clock.now())),
    );

    expect(result.method).toBe('totp');
    expect(result.factorId).toBe(bundle.factorId);
    expect(result.counter).not.toBeNull();
    expect(h.factors.spentCounters()).toEqual([result.counter ? BigInt(result.counter) : 0n]);
  });

  it('rejects a replay of a code that already verified', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);

    h.clock.advance(30_000);
    const code = totp.currentCode(bundle.secret, h.clock.now());
    await h.verify.execute(new VerifyFactorCommand(USER_ID, code));

    // Same code, same instant, brand-new aggregate loaded from storage — exactly what a
    // captured request replayed twenty seconds later looks like.
    await expect(h.verify.execute(new VerifyFactorCommand(USER_ID, code))).rejects.toThrow(
      /not accepted/,
    );
    // And it stays refused: the marker is the record, not a one-shot flag.
    await expect(h.verify.execute(new VerifyFactorCommand(USER_ID, code))).rejects.toThrow();
  });

  it('does not move the spent step when a replay is refused', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);

    h.clock.advance(30_000);
    const code = totp.currentCode(bundle.secret, h.clock.now());
    const first = await h.verify.execute(new VerifyFactorCommand(USER_ID, code));
    const before = h.factors.spentCounters();

    await expect(h.verify.execute(new VerifyFactorCommand(USER_ID, code))).rejects.toThrow();

    expect(h.factors.spentCounters()).toEqual(before);
    expect(h.factors.spentCounters()[0]).toBe(BigInt(first.counter as string));
  });

  it('refuses to verify a factor that was never confirmed', async () => {
    const h = harness();
    const bundle = await h.begin.execute(new BeginEnrollmentCommand(USER_ID));

    await expect(
      h.verify.execute(
        new VerifyFactorCommand(USER_ID, totp.currentCode(bundle.secret, T0)),
      ),
    ).rejects.toThrow();
  });

  it('refuses a code from outside the window', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);

    // 60s after the step the app is showing: two steps out, one step beyond `window = 1`.
    h.clock.advance(60_000);
    await expect(
      h.verify.execute(
        new VerifyFactorCommand(USER_ID, totp.currentCode(bundle.secret, T0)),
      ),
    ).rejects.toThrow(/not accepted/);
  });

  it('accepts a code from inside the window', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);

    h.clock.advance(60_000);
    const result = await h.verify.execute(
      new VerifyFactorCommand(USER_ID, totp.currentCode(bundle.secret, new Date(T0.getTime() + 30_000))),
    );

    expect(result.factorId).toBe(bundle.factorId);
  });

  it('locks the factor after the configured number of wrong codes', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);

    for (let attempt = 0; attempt < config.maxFailedAttempts; attempt += 1) {
      await expect(
        h.verify.execute(new VerifyFactorCommand(USER_ID, '000000')),
      ).rejects.toThrow();
    }

    const stored = h.factors.rows.get(bundle.factorId);
    expect(stored?.failed_attempts).toBe(config.maxFailedAttempts);
    expect(stored?.locked_until).not.toBeNull();

    // Even the correct code is refused while the lock holds.
    h.clock.advance(30_000);
    await expect(
      h.verify.execute(
        new VerifyFactorCommand(USER_ID, totp.currentCode(bundle.secret, h.clock.now())),
      ),
    ).rejects.toThrow(/locked/);
  });

  it('does not let one user verify another user’s factor', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);
    h.clock.advance(30_000);

    await expect(
      h.verify.execute(
        new VerifyFactorCommand(
          OTHER_USER_ID,
          totp.currentCode(bundle.secret, h.clock.now()),
          'totp',
          bundle.factorId,
        ),
      ),
    ).rejects.toThrow(/no such factor/);
  });
});

describe('VerifyFactor — recovery codes', () => {
  it('accepts a code once and refuses it forever after', async () => {
    const h = harness();
    const issued = await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 4));
    const [first, second] = issued.codes as [string, string];

    const result = await h.verify.execute(
      new VerifyFactorCommand(USER_ID, first, 'backup_code'),
    );
    expect(result.method).toBe('backup_code');
    expect(result.factorId).toBeNull();

    await expect(
      h.verify.execute(new VerifyFactorCommand(USER_ID, first, 'backup_code')),
    ).rejects.toThrow();
    // A sibling code from the same set still works: they are independent single-use values.
    await expect(
      h.verify.execute(new VerifyFactorCommand(USER_ID, second, 'backup_code')),
    ).resolves.toMatchObject({ method: 'backup_code' });
  });

  it('stores only digests', async () => {
    const h = harness();
    const issued = await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));

    const stored = h.sets.row?.mfa_recovery_codes ?? [];
    expect(stored).toHaveLength(3);
    for (const code of issued.codes) {
      expect(stored.some((row) => row.digest === code)).toBe(false);
      expect(JSON.stringify(h.sets.row)).not.toContain(code);
    }
  });

  it('refuses a code from a superseded set', async () => {
    const h = harness();
    const first = await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));
    await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));

    for (const code of first.codes) {
      await expect(
        h.verify.execute(new VerifyFactorCommand(USER_ID, code, 'backup_code')),
      ).rejects.toThrow();
    }
  });

  it('refuses when the user holds no set at all', async () => {
    const h = harness();

    await expect(
      h.verify.execute(new VerifyFactorCommand(USER_ID, 'ABCDE-FGHJK', 'backup_code')),
    ).rejects.toThrow(/no recovery codes/i);
  });

  it('leaves nothing behind that could be turned back into a usable code', async () => {
    const h = harness();
    const issued = await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 2));
    const code = issued.codes[0] as string;

    await h.verify.execute(new VerifyFactorCommand(USER_ID, code, 'backup_code'));

    // The row records *that* the code was spent and *when*, never the code itself: the
    // digest is one-way, so the flag is evidence without being a credential.
    const stored = h.sets.row?.mfa_recovery_codes?.find((row) => row.code_index === 0);
    expect(stored?.consumed_at).toEqual(T0);
    expect(JSON.stringify(h.sets.row)).not.toContain(code);
    expect(codes.digest(code, h.sets.row?.salt as string)).toBe(stored?.digest);
  });
});

describe('RegenerateRecoveryCodes', () => {
  it('issues a set once, then rotates it', async () => {
    const h = harness();

    const first = await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 6));
    expect(first.regenerated).toBe(false);
    expect(first.count).toBe(6);
    for (const code of first.codes) {
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    }

    const saltBefore = h.sets.row?.salt;
    const second = await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 6));

    expect(second.regenerated).toBe(true);
    expect(h.sets.row?.salt).not.toBe(saltBefore);
    expect(second.codes.filter((code) => first.codes.includes(code))).toHaveLength(0);
  });

  it('restores the remaining count after a rotation', async () => {
    const h = harness();
    const first = await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 4));
    await h.verify.execute(new VerifyFactorCommand(USER_ID, first.codes[0] as string, 'backup_code'));

    expect((await h.status.execute(new GetMfaStatusQuery(USER_ID))).recoveryCodes?.remaining).toBe(3);

    await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 4));

    expect((await h.status.execute(new GetMfaStatusQuery(USER_ID))).recoveryCodes?.remaining).toBe(4);
  });

  it('never exceeds the configured maximum', async () => {
    const h = harness();

    const bundle = await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 999));

    expect(bundle.count).toBe(config.recoveryCodeCount);
  });
});

describe('DisableMfa', () => {
  it('refuses without a valid code and keeps the secret', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);

    await expect(
      h.disable.execute(new DisableMfaCommand(USER_ID, bundle.factorId, '000000')),
    ).rejects.toThrow();

    expect(h.factors.rows.get(bundle.factorId)?.secret_ciphertext).not.toBeNull();
    expect(h.factors.rows.get(bundle.factorId)?.status).toBe('active');
  });

  it('turns the factor off and destroys the secret', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);
    h.clock.advance(30_000);

    await h.disable.execute(
      new DisableMfaCommand(USER_ID, bundle.factorId, totp.currentCode(bundle.secret, h.clock.now())),
    );

    const stored = h.factors.rows.get(bundle.factorId);
    expect(stored?.status).toBe('disabled');
    expect(stored?.secret_ciphertext).toBeNull();
    expect(stored?.totp_used_counters ?? null).toBeNull();

    // The captured code is worthless against a factor that no longer exists.
    await expect(
      h.verify.execute(
        new VerifyFactorCommand(USER_ID, totp.currentCode(bundle.secret, h.clock.now())),
      ),
    ).rejects.toThrow();
  });
});

describe('GetMfaStatus', () => {
  it('reports "not enrolled" before anything happens', async () => {
    const h = harness();

    const status = await h.status.execute(new GetMfaStatusQuery(USER_ID));

    expect(status.enrolled).toBe(false);
    expect(status.factors).toHaveLength(0);
    expect(status.activeFactorId).toBeNull();
    expect(status.recoveryCodes).toBeNull();
  });

  it('surfaces the pending enrollment so a UI can resume it', async () => {
    const h = harness();
    const bundle = await h.begin.execute(new BeginEnrollmentCommand(USER_ID));

    const status = await h.status.execute(new GetMfaStatusQuery(USER_ID));

    expect(status.enrolled).toBe(false);
    expect(status.pendingFactorId).toBe(bundle.factorId);
    expect(status.factors[0]?.verifiable).toBe(false);
  });

  it('reports the active factor, its method and the recovery budget', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);
    await h.regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 5));

    const status = await h.status.execute(new GetMfaStatusQuery(USER_ID));

    expect(status.enrolled).toBe(true);
    expect(status.activeFactorId).toBe(bundle.factorId);
    expect(status.factors[0]?.method).toBe('totp');
    expect(status.factors[0]?.verifiable).toBe(true);
    expect(status.recoveryCodes).toMatchObject({ total: 5, remaining: 5 });
    // Never any part of the secret, in any form.
    expect(JSON.stringify(status)).not.toContain(bundle.secret);
  });
});

describe('transaction discipline', () => {
  it('opens exactly one transaction per successful command', async () => {
    const h = harness();
    const before = h.uow.commits.length;

    const { bundle } = await enrolled(h);
    h.clock.advance(30_000);
    await h.verify.execute(
      new VerifyFactorCommand(USER_ID, totp.currentCode(bundle.secret, h.clock.now())),
    );

    // begin + confirm + verify.
    expect(h.uow.commits.length - before).toBe(3);
  });

  it('opens one transaction for a refused command, to record the attempt', async () => {
    const h = harness();
    const { bundle } = await enrolled(h);
    const before = h.uow.commits.length;

    await expect(
      h.verify.execute(new VerifyFactorCommand(USER_ID, '000000')),
    ).rejects.toThrow();

    // One, not two: the failing verification never opened one to roll back, and the counter
    // is written in the single transaction that follows it.
    expect(h.uow.commits.length - before).toBe(1);
    expect(h.factors.rows.get(bundle.factorId)?.failed_attempts).toBe(1);
  });
});

describe('configuration reaches the domain', () => {
  it('only ever accepts six digits for the TOTP path', () => {
    expect(TOTP_CODE_PATTERN.test('123456')).toBe(true);
    expect(TOTP_CODE_PATTERN.test('12345')).toBe(false);
    expect(TOTP_CODE_PATTERN.test('1234567')).toBe(false);
  });

  it('translates the namespace into the policy the aggregate is handed', () => {
    // The aggregate must not know a lockout is expressed in seconds in configuration and
    // milliseconds in the domain; `toPolicy` is the one place that knows.
    expect(toPolicy(config)).toEqual({
      window: config.totpWindow,
      maxFailedAttempts: config.maxFailedAttempts,
      lockoutMs: config.lockoutSec * 1_000,
    });
  });
});
/**
 * @fileoverview The CQRS wiring itself.
 *
 * @remarks `@nestjs/cqrs` v11 dispatches on `command.constructor` and reads
 * `@CommandHandler`'s metadata off whatever it is given. A string bus key throws *at import*
 * — `Reflect.hasOwnMetadata` rejects a non-object — and a plain object literal silently never
 * dispatches. Both failures surface as "the route returns undefined", far from the line that
 * caused them, so they are worth asserting here rather than discovering in production.
 */

import 'reflect-metadata';
import { COMMAND_HANDLER_METADATA, QUERY_HANDLER_METADATA } from '@nestjs/cqrs/dist/decorators/constants';
import { MfaService } from '../src/application/facade/mfa.service';

/**
 * The class `@nestjs/cqrs` will look the handler up by.
 *
 * @remarks v11 stores the class itself — not an array of arguments and not a string — and
 * `CommandBus.execute` resolves on `command.constructor`. Anything else here means the
 * command is constructed and then silently dropped.
 */
const registeredFor = (key: string, handler: object): unknown =>
  Reflect.getMetadata(key, handler) as unknown;

describe('CQRS wiring', () => {
  it.each([
    ['BeginEnrollment', BeginEnrollmentHandler, BeginEnrollmentCommand],
    ['ConfirmEnrollment', ConfirmEnrollmentHandler, ConfirmEnrollmentCommand],
    ['VerifyFactor', VerifyFactorHandler, VerifyFactorCommand],
    ['DisableMfa', DisableMfaHandler, DisableMfaCommand],
    ['RegenerateRecoveryCodes', RegenerateRecoveryCodesHandler, RegenerateRecoveryCodesCommand],
  ])('binds %s to its command class, not to a name', (_name, handler, command) => {
    const bound = registeredFor(COMMAND_HANDLER_METADATA, handler);

    expect(bound).toBe(command);
    expect(typeof bound).toBe('function');
    expect(typeof bound).not.toBe('string');
  });

  it('binds GetMfaStatus to its query class', () => {
    expect(registeredFor(QUERY_HANDLER_METADATA, GetMfaStatusHandler)).toBe(GetMfaStatusQuery);
  });

  it('gives every command a fresh id and an inherited Command prototype', () => {
    const first = new VerifyFactorCommand(USER_ID, '123456');
    const second = new VerifyFactorCommand(USER_ID, '123456');

    expect(first.commandId).not.toBe(second.commandId);
    // `CommandBus.execute` walks this chain to find the bus metadata; losing it means the
    // command is constructed and then quietly dropped.
    expect(first.constructor).toBe(VerifyFactorCommand);
    expect(typeof first.commandId).toBe('string');
    expect(first.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exposes MfaService as the module public surface', () => {
    for (const method of [
      'beginEnrollment',
      'confirmEnrollment',
      'verifyFactor',
      'disableMfa',
      'regenerateRecoveryCodes',
      'getStatus',
      'verifyOwnership',
    ] as const) {
      expect(typeof MfaService.prototype[method]).toBe('function');
    }
  });
});
