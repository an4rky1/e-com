/**
 * @fileoverview Registration, as a sequence rather than as an HTTP status.
 *
 * @remarks The order asserted here *is* the design: the password is stored against the id
 * the account will have, and only then does the account claim that id. credential-vault's
 * policy lives in credential-vault, so a refusal there has to land on a credential nothing
 * points at — never on a half-made account. Each test therefore asks what the *other* peers
 * saw, not only what the caller was told.
 *
 * @remarks The password-confidentiality claim gets a second observation here: registration
 * is the one flow where the secret crosses two peer calls' worth of arguments, and "it only
 * ever appeared in the vault's" is checkable precisely because the doubles record everything.
 */
import {
  DependencyUnavailableException,
  ResourceAlreadyExistsException,
  ValidationException,
} from '@auth/platform/error-handling';
import { GatewayService } from '../src/application/facade/gateway.service';
import {
  EMAIL,
  PASSWORD,
  FakeAccessControlClient,
  FakeAuthFlowClient,
  FakeCredentialVaultClient,
  FakeIdentityClient,
  FakeSessionClient,
} from './testing/peer-doubles';

const serviceWith = () => {
  const flows = new FakeAuthFlowClient();
  const identity = new FakeIdentityClient();
  const accessControl = new FakeAccessControlClient();
  const sessions = new FakeSessionClient();
  const credentials = new FakeCredentialVaultClient();

  const service = new GatewayService(
    flows,
    identity,
    accessControl,
    sessions,
    credentials,
  );

  return { service, identity, accessControl, sessions, credentials };
};

const registerWith = (service: GatewayService) =>
  service.register({ email: EMAIL, password: PASSWORD, ipAddress: '10.0.0.1' });

describe('GatewayService.register', () => {
  it('stores the password against the id the account will have, then issues the session', async () => {
    const { service, identity, credentials, sessions } = serviceWith();

    const result = await registerWith(service);

    expect(credentials.stored).toHaveLength(1);
    const userId = credentials.stored[0]!.userId;
    // The account claimed exactly the id the credential was filed under — one identity,
    // two halves, chosen here rather than discovered after the fact.
    expect(identity.created).toEqual([
      { id: userId, email: EMAIL, displayName: undefined, locale: undefined, source: 'web' },
    ]);
    expect(sessions.issued).toEqual([{ userId, email: EMAIL, ipAddress: '10.0.0.1' }]);
    expect(result).toEqual(sessions.issueResult);
  });

  it('grants the baseline shopper role to the account it just created', async () => {
    const { service, identity, accessControl } = serviceWith();

    await registerWith(service);

    expect(accessControl.roleGrants).toEqual([
      { userId: identity.created[0]!.id, role: 'user', grantedBy: 'self-registration' },
    ]);
  });

  it('still completes the sign-up when access-control cannot grant the role', async () => {
    const { service, accessControl, sessions } = serviceWith();
    accessControl.grantError = new DependencyUnavailableException(
      'access-control did not answer',
    );

    await registerWith(service);

    // The account and credential are whole; a missing baseline role is recoverable and
    // must not turn a completed registration into an error the caller cannot act on.
    expect(sessions.issued).toHaveLength(1);
  });

  it('refuses a password the vault rejects before an account exists', async () => {
    const { service, identity, credentials, sessions } = serviceWith();
    credentials.error = new ValidationException('password does not meet the policy');

    const error = await registerWith(service).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationException);
    // The whole point of the order: nothing was created, nothing was issued.
    expect(identity.created).toEqual([]);
    expect(sessions.issued).toEqual([]);
  });

  it('revokes the orphan credential when identity refuses the address', async () => {
    const { service, identity, credentials, sessions } = serviceWith();
    identity.createError = new ResourceAlreadyExistsException(
      'a user with this email already exists',
    );

    const error = await registerWith(service).catch((e: unknown) => e);

    // The original refusal travels — the caller still learns their address is taken.
    expect(error).toBeInstanceOf(ResourceAlreadyExistsException);
    expect(credentials.revoked).toEqual([
      { userId: credentials.stored[0]!.userId, reason: 'registration_refused' },
    ]);
    expect(sessions.issued).toEqual([]);
  });

  it('keeps a failed compensation from masking the refusal', async () => {
    const { service, identity, credentials } = serviceWith();
    identity.createError = new ResourceAlreadyExistsException(
      'a user with this email already exists',
    );
    credentials.revokeError = new DependencyUnavailableException(
      'the credential vault did not answer',
    );

    const error = await registerWith(service).catch((e: unknown) => e);

    // A vault that cannot clean up must not turn "your address is taken" into a 503.
    expect(error).toBeInstanceOf(ResourceAlreadyExistsException);
    expect(credentials.revoked).toHaveLength(1);
  });

  it('leaves a complete account when only the session cannot be minted', async () => {
    const { service, identity, credentials, sessions } = serviceWith();
    sessions.issueError = new DependencyUnavailableException(
      'session did not answer',
    );

    const error = await registerWith(service).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DependencyUnavailableException);
    // Both writes landed, so the account is whole: the caller can simply sign in, and
    // compensating it away would delete an account over a transient outage.
    expect(identity.created).toHaveLength(1);
    expect(credentials.revoked).toEqual([]);
  });

  it('keeps the password in the vault call and nowhere else', async () => {
    const { service, identity, credentials, sessions } = serviceWith();

    await registerWith(service);

    expect(credentials.stored[0]!.newPassword).toBe(PASSWORD);
    expect(JSON.stringify(identity.created)).not.toContain(PASSWORD);
    expect(JSON.stringify(sessions.issued)).not.toContain(PASSWORD);
    expect(JSON.stringify(sessions.issueResult)).not.toContain(PASSWORD);
  });
});
