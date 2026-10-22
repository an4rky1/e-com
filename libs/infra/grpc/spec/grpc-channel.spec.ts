/**
 * @fileoverview Both gRPC channel implementations present the platform service token.
 *
 * @remarks There are two {@link GrpcChannel} implementations, and the failure this file exists
 * to prevent is one of them attaching the token and the other not: every service would then be
 * authenticated in some paths and open in others, with nothing in the type system or at boot to
 * say which. The same assertions are made against both classes for that reason.
 */
import { Metadata } from '@grpc/grpc-js';
import { GrpcRetryRegistry } from '../src/grpc-channel.port';
import { GRPC_SERVICE_TOKEN_METADATA_KEY } from '../src/service-token';
import { NestGrpcChannel } from '../src/nest-grpc-channel';
import { StaticGrpcChannel } from '../src/static-grpc-channel';

const TOKEN = 'a-shared-service-token-value';
const METHOD = '/identity.v1.IdentityService/GetUser';
const REQUEST = { id: 'user-1' };
const DEADLINE = 1_700_000_000_000;

describe('StaticGrpcChannel', () => {
  function channelWith(options?: { serviceToken?: string }) {
    const calls: Array<{ request: unknown; metadata: Metadata }> = [];
    const client = {
      GetUser(
        request: unknown,
        metadata: Metadata,
        _options: { deadline: Date },
        callback: (error: Error | null, response: unknown) => void,
      ) {
        calls.push({ request, metadata });
        callback(null, { id: 'user-1' });
      },
    };

    const channel = new StaticGrpcChannel(
      new Map([['identity.v1', { IdentityService: client }]]),
      new GrpcRetryRegistry(),
      3_000,
      options?.serviceToken,
    );

    return { calls, channel };
  }

  it('presents the token on every call', async () => {
    const { calls, channel } = channelWith({ serviceToken: TOKEN });

    await channel.unary(METHOD, REQUEST, { deadline: DEADLINE });

    expect(calls).toHaveLength(1);
    expect(calls[0].metadata.get(GRPC_SERVICE_TOKEN_METADATA_KEY)).toEqual([TOKEN]);
  });

  it('keeps its own token when a caller supplies one, because the token belongs to the transport', async () => {
    const { calls, channel } = channelWith({ serviceToken: TOKEN });

    await channel.unary(METHOD, REQUEST, {
      deadline: DEADLINE,
      metadata: { [GRPC_SERVICE_TOKEN_METADATA_KEY]: 'forged-by-the-caller' },
    });

    expect(calls[0].metadata.get(GRPC_SERVICE_TOKEN_METADATA_KEY)).toEqual([TOKEN]);
  });

  it('preserves the caller’s other headers', async () => {
    const { calls, channel } = channelWith({ serviceToken: TOKEN });

    await channel.unary(METHOD, REQUEST, {
      deadline: DEADLINE,
      metadata: { 'x-request-id': 'trace-1' },
    });

    expect(calls[0].metadata.get('x-request-id')).toEqual(['trace-1']);
    expect(calls[0].metadata.get(GRPC_SERVICE_TOKEN_METADATA_KEY)).toEqual([TOKEN]);
  });

  it('attaches nothing when built without a token, leaving the decision to the receiving guard', async () => {
    const { calls, channel } = channelWith();

    await channel.unary(METHOD, REQUEST, { deadline: DEADLINE });

    expect(calls[0].metadata.get(GRPC_SERVICE_TOKEN_METADATA_KEY)).toEqual([]);
  });
});

describe('NestGrpcChannel', () => {
  function channelWith(options?: { serviceToken?: string }) {
    const calls: Array<{ request: unknown; metadata: unknown }> = [];
    const askedFor: string[] = [];
    const clientMethod = (
      request: unknown,
      metadata: unknown,
      _options: { deadline: Date },
      callback: (error: unknown, response: unknown) => void,
    ) => {
      calls.push({ request, metadata });
      callback(null, { id: 'user-1' });
    };

    const client = {
      getService(name: string) {
        askedFor.push(name);
        return { GetUser: clientMethod };
      },
    };

    return { calls, askedFor, channel: new NestGrpcChannel(client, options?.serviceToken) };
  }

  it('presents the token on every call', async () => {
    const { calls, channel } = channelWith({ serviceToken: TOKEN });

    await channel.unary(METHOD, REQUEST, { deadline: DEADLINE });

    const metadata = calls[0].metadata as Metadata;
    expect(metadata.get(GRPC_SERVICE_TOKEN_METADATA_KEY)).toEqual([TOKEN]);
  });

  it('looks the service up by the name the proto declares, and the method by its own name', async () => {
    const { askedFor, channel } = channelWith({ serviceToken: TOKEN });

    await channel.unary(METHOD, REQUEST, { deadline: DEADLINE });

    // `/identity.v1.IdentityService/GetUser`: the service is `IdentityService`, the method is
    // `GetUser`. Concatenating or re-casing the path produces a name Nest has never heard of.
    expect(askedFor).toEqual(['IdentityService']);
  });

  it('keeps its own token when a caller supplies one', async () => {
    const { calls, channel } = channelWith({ serviceToken: TOKEN });

    await channel.unary(METHOD, REQUEST, {
      deadline: DEADLINE,
      metadata: { [GRPC_SERVICE_TOKEN_METADATA_KEY]: 'forged-by-the-caller' },
    });

    const metadata = calls[0].metadata as Metadata;
    expect(metadata.get(GRPC_SERVICE_TOKEN_METADATA_KEY)).toEqual([TOKEN]);
  });

  it('passes no metadata at all when built without a token', async () => {
    const { calls, channel } = channelWith();

    await channel.unary(METHOD, REQUEST, { deadline: DEADLINE });

    expect(calls[0].metadata).toBeUndefined();
  });

  it('refuses a method path missing its service or method halves', async () => {
    const { channel } = channelWith({ serviceToken: TOKEN });

    await expect(channel.unary('/GetUser', REQUEST, { deadline: DEADLINE })).rejects.toThrow(
      /Malformed gRPC method path/,
    );
  });

  it('reports a method the loaded definition does not contain', async () => {
    const { channel } = channelWith({ serviceToken: TOKEN });

    await expect(
      channel.unary('/identity.v1.IdentityService/DeleteUser', REQUEST, { deadline: DEADLINE }),
    ).rejects.toThrow(/not present in the loaded proto definition/);
  });
});
