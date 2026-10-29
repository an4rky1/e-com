/**
 * @fileoverview What a peer failure becomes, and what it is never allowed to become.
 *
 * @remarks Two claims are under test. First, the mapping: a peer that refuses authentication
 * must not read as a 500, and a peer that cannot be reached must not read as anything but a
 * 503 with a stable code. Second, and more important, that the *peer's own message* never
 * survives the trip — a gRPC error body reaches the client verbatim, so a status translation
 * that passed the message along would have fixed the status code and kept the leak.
 *
 * @remarks The deadline is asserted here too, because it is the same seam: a call that reached
 * the channel without one is indistinguishable from a call that would have waited forever.
 */
import { HttpStatus } from '@nestjs/common';
import { AppException } from '@auth/platform/error-handling';
import { GrpcStatus } from '@auth/infra/grpc';
import { PeerCaller } from '../src/infrastructure/grpc/peer-caller';
import {
  GrpcAuthFlowClient,
  GrpcIdentityClient,
} from '../src/infrastructure/grpc/grpc-peer-clients';
import { testGatewayConfig, ScriptedChannel, grpcError } from './testing/peer-doubles';

const START_FLOW = '/auth_flow.v1.AuthFlowService/StartFlow';
const CREATE_USER = '/identity.v1.IdentityService/CreateUser';

const callerFor = (channel: ScriptedChannel, deadlineMs = 500) =>
  new PeerCaller(channel, testGatewayConfig({ peerDeadlineMs: deadlineMs }));

describe('peer failure translation', () => {
  it.each([
    ['UNAUTHENTICATED', GrpcStatus.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED],
    ['PERMISSION_DENIED', GrpcStatus.PERMISSION_DENIED, HttpStatus.FORBIDDEN],
    ['NOT_FOUND', GrpcStatus.NOT_FOUND, HttpStatus.NOT_FOUND],
    ['ALREADY_EXISTS', GrpcStatus.ALREADY_EXISTS, HttpStatus.CONFLICT],
    ['INVALID_ARGUMENT', GrpcStatus.INVALID_ARGUMENT, HttpStatus.BAD_REQUEST],
    ['UNAVAILABLE', GrpcStatus.UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE],
    ['DEADLINE_EXCEEDED', GrpcStatus.DEADLINE_EXCEEDED, HttpStatus.SERVICE_UNAVAILABLE],
    ['UNIMPLEMENTED', GrpcStatus.UNIMPLEMENTED, HttpStatus.SERVICE_UNAVAILABLE],
    ['RESOURCE_EXHAUSTED', GrpcStatus.RESOURCE_EXHAUSTED, HttpStatus.TOO_MANY_REQUESTS],
  ])('maps %s to %s', async (_label, status, expected) => {
    const channel = new ScriptedChannel().on(START_FLOW, grpcError(status));
    const flows = new GrpcAuthFlowClient(callerFor(channel));

    const error = (await flows
      .startFlow({ email: 'person@example.com' })
      .catch((e: unknown) => e)) as AppException;

    expect(error).toBeInstanceOf(AppException);
    expect(error.getStatus()).toBe(expected);
  });

  it.each([GrpcStatus.UNAVAILABLE, GrpcStatus.DEADLINE_EXCEEDED])(
    'answers an unreachable peer (%s) with one stable code',
    async (status) => {
      const channel = new ScriptedChannel().on(START_FLOW, grpcError(status));
      const flows = new GrpcAuthFlowClient(callerFor(channel));

      const error = (await flows
        .startFlow({ email: 'person@example.com' })
        .catch((e: unknown) => e)) as AppException;

      // A 503 rather than a 504 on a deadline, on purpose: by the time it expires the
      // downstream call was abandoned before it could commit, so "nothing happened, come
      // back" is the honest answer — and it is the same answer as a refused connection.
      expect(error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    },
  );

  it('reads a status the same way on every method, so no status means two things', async () => {
    const channel = new ScriptedChannel().on(START_FLOW, grpcError(GrpcStatus.INVALID_ARGUMENT));
    const flows = new GrpcAuthFlowClient(callerFor(channel));

    const error = (await flows
      .startFlow({ email: 'person@example.com' })
      .catch((e: unknown) => e)) as AppException;

    // `INVALID_ARGUMENT` is a bad request here, and it is a bad request on `CreateUser`
    // too. Reading it as "wrong password" because that is what it means on the login path
    // would make a malformed address answer 401.
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('never lets the peer\'s own message reach the client', async () => {
    const secret = 'connection to postgres://user:hunter2@db.internal:5432 failed';
    const channel = new ScriptedChannel().on(START_FLOW, grpcError(GrpcStatus.UNAVAILABLE, secret));
    const flows = new GrpcAuthFlowClient(callerFor(channel));

    const error = (await flows
      .startFlow({ email: 'person@example.com' })
      .catch((e: unknown) => e)) as AppException;

    const rendered = JSON.stringify({
      message: error.message,
      context: error.context,
      body: error.getResponse(),
    });

    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('db.internal');
    // The method path is the platform's own contract, so it is kept.
    expect(error.context['method']).toBe(START_FLOW);
  });

  it('answers an unclassifiable failure with a 5xx rather than a client error', async () => {
    const channel = new ScriptedChannel().on(START_FLOW, new Error('what happened'));
    const flows = new GrpcAuthFlowClient(callerFor(channel));

    const error = (await flows
      .startFlow({ email: 'person@example.com' })
      .catch((e: unknown) => e)) as AppException;

    // Loud on purpose: a failure nobody classified should page somebody rather than read as
    // something the caller did wrong.
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('passes an AppException through untouched, so a service that already spoke is not re-spoken', async () => {
    const original = new AppException({ code: 'ACCOUNT_LOCKED' });
    const channel = new ScriptedChannel().on(START_FLOW, original);
    const flows = new GrpcAuthFlowClient(callerFor(channel));

    await expect(
      flows.startFlow({ email: 'person@example.com' }),
    ).rejects.toBe(original);
  });
});

describe('deadlines', () => {
  it('gives every outbound call one, computed per call', async () => {
    const channel = new ScriptedChannel().on(START_FLOW, {
      flowId: 'flow-1',
      state: 'awaiting_credential',
      flow: 'login',
    });
    const flows = new GrpcAuthFlowClient(callerFor(channel, 250));

    await flows.startFlow({ email: 'person@example.com' });

    expect(channel.calls).toHaveLength(1);
    const deadline = channel.calls[0]?.deadline ?? 0;
    // Absolute, and in the future. A deadline captured at construction would already have
    // expired by the time the request arrived.
    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline).toBeLessThanOrEqual(Date.now() + 250);
  });
});

describe('GrpcAuthFlowClient', () => {
  it('asks for the login flow and nothing else', async () => {
    const channel = new ScriptedChannel().on(START_FLOW, {
      flowId: 'flow-1',
      state: 'awaiting_credential',
      flow: 'login',
    });
    const flows = new GrpcAuthFlowClient(callerFor(channel));

    await flows.startFlow({ email: 'person@example.com' });

    // `/auth/login` is the login flow. A body field choosing the name would make this
    // endpoint a front door to `reset_password`.
    expect(channel.calls[0]?.request).toEqual({
      flow: 'login',
      email: 'person@example.com',
      ipAddress: undefined,
      userAgent: undefined,
    });
  });

  it('reads an unset proto field as absent rather than as an empty string', async () => {
    const channel = new ScriptedChannel().on(START_FLOW, {
      flowId: 'flow-1',
      state: 'awaiting_credential',
      flow: 'login',
      expiresIn: 0,
      message: '',
    });
    const flows = new GrpcAuthFlowClient(callerFor(channel));

    const progress = await flows.startFlow({ email: 'person@example.com' });

    // The loader runs with `defaults: true`, so an unset int arrives as `0` — which is
    // indistinguishable from a token that is already dead.
    expect(progress.expiresIn).toBeUndefined();
    expect(progress.message).toBeUndefined();
  });
});

describe('GrpcIdentityClient', () => {
  it('refuses a create reply that carried no user', async () => {
    const channel = new ScriptedChannel().on(CREATE_USER, {});
    const identity = new GrpcIdentityClient(callerFor(channel));

    const error = await identity
      .createUser({ email: 'person@example.com' })
      .catch((e: unknown) => e);

    // The proto has exactly one field, so this is a peer answering something other than what
    // it promised. Asserted, not cast through.
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe('INTERNAL_ERROR');
  });
});
