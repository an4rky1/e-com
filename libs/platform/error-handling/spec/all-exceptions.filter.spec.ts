import { HttpStatus, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { ResourceNotFoundException } from '../src/exceptions';
import { AllExceptionsFilter } from '../src/filters/all-exceptions.filter';

/** Minimal host; the filter only ever asks `getType()` and then switches transport. */
function rpcHost(): ArgumentsHost {
  return { getType: () => 'rpc' } as unknown as ArgumentsHost;
}

function httpHost(): {
  host: ArgumentsHost;
  response: { status: jest.Mock; type: jest.Mock; json: jest.Mock };
} {
  const response = { status: jest.fn(), type: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  response.type.mockReturnValue(response);
  const request = { headers: {}, originalUrl: '/x', url: '/x', method: 'GET' };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('AllExceptionsFilter over gRPC', () => {
  it('returns an errored stream instead of throwing out of catch', () => {
    // The contract that matters: a filter's return value is the stream Nest hands to the gRPC
    // server. Throwing here tears the call down with no status at all, and every caller then
    // reports UNAVAILABLE for what was really a 404 — an outage that only the server log
    // contradicts.
    const filter = new AllExceptionsFilter();

    let returned: unknown;
    expect(() => {
      returned = filter.catch(new ResourceNotFoundException('user not found'), rpcHost());
    }).not.toThrow();

    return expect(firstValueFrom(returned as never)).rejects.toMatchObject({
      code: 5,
      details: 'RESOURCE_NOT_FOUND',
      message: 'user not found',
    });
  });

  it('keeps an unrecognised error loud rather than mapping it to a client code', async () => {
    const filter = new AllExceptionsFilter();
    const error = await firstValueFrom(
      filter.catch(new Error('connection string leaked'), rpcHost()) as never,
    ).catch((e: unknown) => e as { code: number; message: string });

    expect(error.code).toBe(2);
    expect(error.message).not.toContain('connection string');
  });

  it('maps a plain HttpException by its status', async () => {
    const filter = new AllExceptionsFilter();
    const error = await firstValueFrom(
      filter.catch(new NotFoundException('gone'), rpcHost()) as never,
    ).catch((e: unknown) => e as { code: number });

    expect(error.code).toBe(5);
  });
});

describe('AllExceptionsFilter over HTTP', () => {
  it('writes problem+json and keeps the raw error out of the body', () => {
    const filter = new AllExceptionsFilter();
    const { host, response } = httpHost();

    filter.catch(new ResourceNotFoundException('user not found', { email: 'a@b.test' }), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(response.type).toHaveBeenCalledWith('application/problem+json');
    const body = response.json.mock.calls[0]?.[0] as { code: string; detail: string };
    expect(body.code).toBe('RESOURCE_NOT_FOUND');
    expect(body.detail).toBe('user not found');
  });

  it('answers an unknown error with a flat 500 and no detail', () => {
    const filter = new AllExceptionsFilter();
    const { host, response } = httpHost();

    filter.catch(new Error('jdbc:postgres://user:pw@host/db'), host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = response.json.mock.calls[0]?.[0] as { detail: string };
    expect(body.detail).not.toContain('jdbc');
  });
});
