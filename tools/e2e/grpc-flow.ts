/**
 * Drives the gRPC half of the login end-to-end test.
 *
 * The shell script boots the services; this runs the calls a browser cannot make directly:
 * set a password, open an auth flow, advance it with the password, and read the tokens back.
 *
 * Nothing here is stubbed. Every call crosses a real socket to a service running in another
 * process, which is the only way to prove the cross-service gRPC wiring actually works —
 * unit tests inject ports, so they cannot catch a channel pointed at the wrong host, a proto
 * package loaded but not addressed, or a method path that names a service nobody declared.
 */
import { createStaticGrpcChannel } from '../../libs/infra/grpc/src/static-grpc-channel';
import { readServiceToken } from '../../libs/infra/grpc/src/service-token';
import { join } from 'node:path';

const PROTO_DIR = join(__dirname, '..', '..', 'libs', 'contracts', 'proto');

const addresses = {
  'identity.v1': process.env.IDENTITY_GRPC_URL ?? 'localhost:31001',
  'credential_vault.v1':
    process.env.CREDENTIAL_VAULT_GRPC_URL ?? 'localhost:31003',
  'session.v1': process.env.SESSION_GRPC_URL ?? 'localhost:31004',
  'mfa.v1': process.env.MFA_GRPC_URL ?? 'localhost:31006',
  // The test drives auth-flow directly, so its proto has to be loaded too.
  'auth_flow.v1': process.env.AUTH_FLOW_GRPC_URL ?? 'localhost:31005',
};

const channel = createStaticGrpcChannel({
  protoPaths: [
    join(PROTO_DIR, 'identity.proto'),
    join(PROTO_DIR, 'credential_vault.proto'),
    join(PROTO_DIR, 'session.proto'),
    join(PROTO_DIR, 'mfa.proto'),
    join(PROTO_DIR, 'auth_flow.proto'),
  ],
  url: addresses['identity.v1'],
  addresses,
  defaultDeadlineMs: 10_000,
  // The services this drives run the same guard as production: a call presenting nothing is
  // refused. The script that boots them exports the token, so it is also the token they answer to.
  serviceToken: readServiceToken(),
});

const call = async <TResponse>(
  method: string,
  request: unknown,
): Promise<TResponse> =>
  channel.unary<TResponse>(method, request as object, {
    deadline: Date.now() + 10_000,
  });

/**
 * The address the flows are opened from.
 *
 * @remarks Randomised per run by the caller. account-security's per-address counter lives for
 * a day and is never cleared by a successful sign-in, so a fixed address accumulates every
 * failure every run and starts locking accounts on the first guess after a few runs — a
 * test that fails on the fourth try for a reason no assertion describes.
 */
const clientIp = process.env.E2E_CLIENT_IP ?? '10.0.0.1';

const step = process.argv[2] ?? 'all';
const email = process.argv[3] ?? '';
const password = process.argv[4] ?? '';

async function main(): Promise<void> {
  if (step === 'set-password') {
    const response = await call<{ ok: boolean; credentialId: string }>(
      '/credential_vault.v1.CredentialVaultService/SetPassword',
      { userId: process.argv[3], newPassword: password },
    );
    console.log(JSON.stringify(response));
    return;
  }

  if (step === 'start-flow') {
    const response = await call<{ flowId: string; state: string; flow: string }>(
      '/auth_flow.v1.AuthFlowService/StartFlow',
      { flow: 'login', email, ipAddress: clientIp },
    );
    console.log(JSON.stringify(response));
    return;
  }

  if (step === 'advance-flow') {
    const response = await call<{
      flowId: string;
      state: string;
      accessToken: string;
      refreshToken: string;
      sessionId: string;
      message: string;
    }>(
      '/auth_flow.v1.AuthFlowService/AdvanceFlow',
      { flowId: process.argv[3], credential: password, ipAddress: clientIp },
    );
    console.log(JSON.stringify(response));
    return;
  }

  if (step === 'validate') {
    const response = await call<{
      valid: boolean;
      userId: string;
      email: string;
      sessionId: string;
      revocationReason: string;
    }>(
      '/session.v1.SessionService/ValidateAccessToken',
      { accessToken: process.argv[3] },
    );
    console.log(JSON.stringify(response));
    return;
  }

  if (step === 'get-user') {
    const response = await call<{ id: string; email: string; status: string }>(
      '/identity.v1.IdentityService/GetUserByEmail',
      { email },
    );
    console.log(JSON.stringify(response));
    return;
  }

  throw new Error(`unknown step "${step}"`);
}

main()
  .then(async () => {
    await channel.close();
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    );
    process.exit(1);
  });