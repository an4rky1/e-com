/**
 * @fileoverview The guest sweep: the cutoff it computes and the clock that fires it.
 *
 * @remarks The service is pure scheduling glue, so its assertions are about *when* the
 * command goes out and what happens after a failed tick — never about the delete itself,
 * which the repository test owns.
 */
import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { UserRepositoryPort } from '../src/domain/ports/user-repository.port';
import { GuestReaperService } from '../src/application/guest-reaper.service';
import { ReapGuestUsersCommand } from '../src/application/commands/reap-guest-users.command';
import { ReapGuestUsersHandler } from '../src/application/commands/reap-guest-users.handler';
import { type IdentityConfig } from '../src/identity.config';

const config = (overrides: Partial<IdentityConfig> = {}): IdentityConfig => ({
  cacheEnabled: true,
  cacheTtlSec: 300,
  defaultLocale: 'en',
  maxPageSize: 100,
  guestReapEnabled: true,
  guestReapMaxAgeDays: 90,
  guestReapIntervalSec: 60,
  ...overrides,
});

const NOW = new Date('2026-11-16T00:00:00.000Z');

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('ReapGuestUsersHandler', () => {
  it('sweeps guests untouched for the full window, clock fixed', async () => {
    jest.useFakeTimers({ now: NOW });

    const deleteStaleGuests = jest.fn().mockResolvedValue(0);
    const handler = new ReapGuestUsersHandler(
      { deleteStaleGuests } as unknown as UserRepositoryPort,
      config(),
    );

    await handler.execute();

    // 90 days before the frozen clock: everything older is stale, the rest survives.
    expect(deleteStaleGuests).toHaveBeenCalledWith(
      new Date('2026-08-18T00:00:00.000Z'),
    );
    jest.useRealTimers();
  });

  it('honours a configured window rather than the default', async () => {
    jest.useFakeTimers({ now: NOW });

    const deleteStaleGuests = jest.fn().mockResolvedValue(2);
    const handler = new ReapGuestUsersHandler(
      { deleteStaleGuests } as unknown as UserRepositoryPort,
      config({ guestReapMaxAgeDays: 30 }),
    );

    const reaped = await handler.execute();

    expect(deleteStaleGuests).toHaveBeenCalledWith(
      new Date('2026-10-17T00:00:00.000Z'),
    );
    expect(reaped).toBe(2);
    jest.useRealTimers();
  });

  it('reports zero when nothing has gone stale', async () => {
    const deleteStaleGuests = jest.fn().mockResolvedValue(0);
    const handler = new ReapGuestUsersHandler(
      { deleteStaleGuests } as unknown as UserRepositoryPort,
      config(),
    );

    await expect(handler.execute()).resolves.toBe(0);
  });
});

describe('GuestReaperService', () => {
  it('keeps CommandBus as a runtime constructor dependency', () => {
    // A type-only import compiles and lints clean, then emits `Object` for the parameter
    // and Nest cannot construct the service. This is the regression the value import fixes.
    const params = Reflect.getMetadata(
      'design:paramtypes',
      GuestReaperService,
    ) as unknown[] | undefined;

    expect(params?.[0]).toBe(CommandBus);
  });

  const bus = (): { instance: CommandBus; execute: jest.Mock } => {
    const execute = jest.fn().mockResolvedValue(0);
    return { instance: { execute } as unknown as CommandBus, execute };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sits idle while reaping is disabled', async () => {
    const { instance, execute } = bus();
    const service = new GuestReaperService(
      instance,
      config({ guestReapEnabled: false }),
    );

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(86_400_000);

    expect(execute).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('sweeps on every interval, one sweep at a time', async () => {
    const { instance, execute } = bus();
    const service = new GuestReaperService(instance, config());
    service.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBeInstanceOf(ReapGuestUsersCommand);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
  });

  it('keeps sweeping after a failed tick', async () => {
    const { instance, execute } = bus();
    execute.mockRejectedValueOnce(new Error('database gone'));
    const service = new GuestReaperService(instance, config());
    service.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
  });

  it('does not let a slow sweep overlap the next tick', async () => {
    const execute = jest.fn();
    let release!: (value: number) => void;
    execute.mockImplementationOnce(
      () => new Promise<number>((resolve) => (release = resolve)),
    );
    const service = new GuestReaperService(
      { execute } as unknown as CommandBus,
      config(),
    );
    service.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(1);

    // The first sweep is still in flight across several intervals: no second may start.
    await jest.advanceTimersByTimeAsync(60_000 * 3);
    expect(execute).toHaveBeenCalledTimes(1);

    release(0);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
  });

  it('clears its timer on shutdown', async () => {
    const { instance, execute } = bus();
    const service = new GuestReaperService(instance, config());
    service.onApplicationBootstrap();
    service.onModuleDestroy();

    await jest.advanceTimersByTimeAsync(60_000_000);

    expect(execute).not.toHaveBeenCalled();
  });
});
