/** @jest-environment node */
import { handleRegister } from '../src/app/api/register/route';

const env = { GATEWAY_URL: 'http://gateway.test:37000' };

const fetchMock = jest.fn();
const originalFetch = global.fetch;

const session = {
  accessToken: 'access.token.value',
  refreshToken: 'refresh.token.value',
  expiresIn: 900,
  sessionId: 'session-1',
  tokenType: 'Bearer',
};

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const register = (input: unknown, overrides: { GATEWAY_URL?: string | undefined } = env) =>
  handleRegister(typeof input === 'string' ? input : JSON.stringify(input), overrides);

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('handleRegister', () => {
  it('forwards a well-formed registration to the gateway and passes its session through', async () => {
    fetchMock.mockResolvedValue(reply(200, session));

    const result = await register({
      email: 'ada@example.test',
      password: 'Str0ng-Passw0rd!x',
      displayName: 'Ada',
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual(session);
    expect(fetchMock).toHaveBeenCalledWith('http://gateway.test:37000/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ada@example.test',
        password: 'Str0ng-Passw0rd!x',
        displayName: 'Ada',
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it('omits displayName when the caller does not send one', async () => {
    fetchMock.mockResolvedValue(reply(200, session));

    await register({ email: 'bob@example.test', password: 'Str0ng-Passw0rd!x' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      email: 'bob@example.test',
      password: 'Str0ng-Passw0rd!x',
    });
  });

  it('drops fields it does not validate instead of forwarding them', async () => {
    fetchMock.mockResolvedValue(reply(200, session));

    await register({
      email: 'ada@example.test',
      password: 'Str0ng-Passw0rd!x',
      displayName: 'Ada',
      locale: 'en-US',
      admin: true,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      email: 'ada@example.test',
      password: 'Str0ng-Passw0rd!x',
      displayName: 'Ada',
    });
  });

  it.each([
    ['an empty body', '', 'The request body must be JSON'],
    ['a malformed body', '{"email":', 'The request body must be JSON'],
    ['a JSON array', '[]', 'The request body must be a JSON object'],
    ['a JSON scalar', '"ada@example.test"', 'The request body must be a JSON object'],
    ['a JSON null', 'null', 'The request body must be a JSON object'],
    ['no email at all', {}, 'email is required'],
    ['a non-string email', { email: 42 }, 'email is required'],
    ['a malformed email', { email: 'ada@localhost' }, 'email must be a valid address'],
    [
      'an over-long email',
      { email: `${'a'.repeat(254)}@example.test` },
      'email must be a valid address',
    ],
    [
      'an email but no password',
      { email: 'ada@example.test' },
      'password is required',
    ],
    [
      'a non-string password',
      { email: 'ada@example.test', password: 42 },
      'password is required',
    ],
    [
      'a password below the contract minimum',
      { email: 'ada@example.test', password: '1234567' },
      'password must be at least 8 characters',
    ],
    [
      'a password above the contract maximum',
      { email: 'ada@example.test', password: 'a'.repeat(513) },
      'password must be at most 512 characters',
    ],
    [
      'a non-string displayName',
      { email: 'ada@example.test', password: 'Str0ng-Passw0rd!x', displayName: 7 },
      'displayName must be a string',
    ],
    [
      'an over-long displayName',
      { email: 'ada@example.test', password: 'Str0ng-Passw0rd!x', displayName: 'x'.repeat(201) },
      'displayName must be at most 200 characters',
    ],
  ])('rejects %s before the gateway is called', async (_label, input, error) => {
    const result = await register(input);

    expect(result).toEqual({ status: 400, body: { error: expect.stringContaining(error) } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not duplicate the vault policy the gateway will apply anyway', async () => {
    // Eight characters is the *edge's* minimum, not the vault's: a password the vault's
    // composition rules refuse must reach the vault (and be refused there, before any
    // account exists) rather than being re-guessed here and drifting apart.
    fetchMock.mockResolvedValue(
      reply(400, {
        statusCode: 400,
        message: ['the password must contain an uppercase letter'],
        error: 'Bad Request',
      }),
    );

    const result = await register({ email: 'ada@example.test', password: 'abcdefgh' });

    expect(result).toEqual({
      status: 400,
      body: { error: 'the password must contain an uppercase letter' },
    });
  });

  it('flattens a gateway validation refusal into the page error shape', async () => {
    fetchMock.mockResolvedValue(
      reply(400, {
        statusCode: 400,
        message: ['email must be a valid address'],
        error: 'Bad Request',
      }),
    );

    const result = await register({ email: 'taken@example.test', password: 'Str0ng-Passw0rd!x' });

    expect(result).toEqual({ status: 400, body: { error: 'email must be a valid address' } });
  });

  it('uses the gateway message when it is a plain string', async () => {
    fetchMock.mockResolvedValue(
      reply(409, { statusCode: 409, message: 'email already registered', error: 'Conflict' }),
    );

    const result = await register({ email: 'taken@example.test', password: 'Str0ng-Passw0rd!x' });

    expect(result).toEqual({ status: 409, body: { error: 'email already registered' } });
  });

  it('surfaces the gateway RFC 7807 detail, which carries no error field', async () => {
    // What the gateway's error filter really sends: `detail` is the sentence a person can
    // read, and a mapping that only knew `error` would show the generic refusal instead.
    fetchMock.mockResolvedValue(
      reply(409, {
        type: 'https://errors.auth.dev/resource_already_exists',
        title: 'RESOURCE_ALREADY_EXISTS',
        status: 409,
        detail: 'the resource already exists',
        instance: '/auth/register',
      }),
    );

    const result = await register({ email: 'taken@example.test', password: 'Str0ng-Passw0rd!x' });

    expect(result).toEqual({ status: 409, body: { error: 'the resource already exists' } });
  });

  it('falls back to a fixed refusal when the gateway sends no message', async () => {
    fetchMock.mockResolvedValue(reply(500, {}));

    const result = await register({ email: 'ada@example.test', password: 'Str0ng-Passw0rd!x' });

    expect(result).toEqual({ status: 500, body: { error: 'The gateway refused the request' } });
  });

  it('reports 502 when the gateway cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await register({ email: 'ada@example.test', password: 'Str0ng-Passw0rd!x' });

    expect(result).toEqual({ status: 502, body: { error: 'The gateway did not answer' } });
  });

  it('reports 502 when the gateway answers with something that is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));

    const result = await register({ email: 'ada@example.test', password: 'Str0ng-Passw0rd!x' });

    expect(result).toEqual({ status: 502, body: { error: 'The gateway did not answer' } });
  });

  it('reports 500 when the gateway address is not configured', async () => {
    const result = await handleRegister(
      JSON.stringify({ email: 'ada@example.test', password: 'Str0ng-Passw0rd!x' }),
      { GATEWAY_URL: undefined },
    );

    expect(result).toEqual({ status: 500, body: { error: 'The gateway address is not configured' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports 500 when the gateway address is not a URL', async () => {
    const result = await register(
      { email: 'ada@example.test', password: 'Str0ng-Passw0rd!x' },
      { GATEWAY_URL: 'not a url' },
    );

    expect(result).toEqual({ status: 500, body: { error: 'The gateway address is not configured' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
