/**
 * @fileoverview The orchestrator: what each flow does when it is walked.
 *
 * @remarks Every port is an in-memory double, so nothing here touches a database, a socket or
 * a Nest container. That is the whole point of the ports: the behaviour that matters — which
 * state a flow reaches, which dependency gets asked, and what the caller is told — is decidable
 * from a flow plus four answers.
 *
 * @remarks The handlers are constructed directly rather than resolved through a container.
 * `@CommandHandler(StartFlowCommand)` still runs, so a command registered under the wrong class
 * would be caught here — but the module graph, the tokens and the Prisma client stay out of a
 * suite that is about state.
 */
import {
  InvalidStateTransitionException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  AdvanceFlowHandler,
  CancelFlowHandler,
  StartFlowHandler,
} from '../src/application/commands/auth-flow.handlers';
import {
  AdvanceFlowCommand,
  CancelFlowCommand,
  FlowMessage,
  StartFlowCommand,
  type FlowOutcome,
} from '../src/application/commands/auth-flow.commands';
import {
  GetFlowHandler,
  GetFlowQuery,
} from '../src/application/queries/auth-flow.queries';
import { MAX_ATTEMPTS_REASON } from '../src/domain/auth-flow.aggregate';
import { AuthFlowState } from '../src/domain/value-objects/auth-flow-state.vo';
import { AuthFlowType } from '../src/domain/value-objects/auth-flow-type.vo';
import { describeSteps } from '../src/domain/value-objects/flow-step.vo';
import { FixedClock } from '../src/infrastructure/time/system-clock';
import type { AuthGatewayConfig } from '../src/auth-gateway.config';
import {
  EMAIL,
  FakeAccountSecurity,
  FakeCredentials,
  FakeIdentity,
  FakeMfa,
  FakeSessions,
  FLOW_TTL_MS,
  InMemoryAuthFlowRepository,
  OTHER_USER_ID,
  T0,
  testConfig,
  USER_ID,
} from './support/fakes';

const PASSWORD = 'correct horse';
const CODE = '123456';

interface Harness {
  clock: FixedClock;
  flows: InMemoryAuthFlowRepository;
  identity: FakeIdentity;
  credentials: FakeCredentials;
  mfa: FakeMfa;
  sessions: FakeSessions;
  start: StartFlowHandler;
  advance: AdvanceFlowHandler;
  cancel: CancelFlowHandler;
  get: GetFlowHandler;
}

function harness(overrides: Partial<AuthGatewayConfig> = {}): Harness {
  const config = testConfig(overrides);
  const clock = new FixedClock(T0);

  const flows = new InMemoryAuthFlowRepository();
  const identity = new FakeIdentity();
  const credentials = new FakeCredentials();
  const mfa = new FakeMfa();
  const sessions = new FakeSessions();

  identity.addUser({ id: USER_ID, email: EMAIL });
  identity.addUser({ id: OTHER_USER_ID, email: 'someone.else@example.com' });
  credentials.password = PASSWORD;
  mfa.acceptedCode = CODE;

  return {
    clock,
    flows,
    identity,
    credentials,
    mfa,
    sessions,
    start: new StartFlowHandler(flows, identity, clock, config),
    advance: new AdvanceFlowHandler(flows, identity, credentials, mfa, sessions, clock),
    cancel: new CancelFlowHandler(flows, clock),
    get: new GetFlowHandler(flows),
  };
}

const openLogin = (h: Harness): Promise<FlowOutcome> =>
  h.start.execute(new StartFlowCommand(AuthFlowType.LOGIN, EMAIL));

// ---- login ----------------------------------------------------------------------

describe('login', () => {
  it('opens in awaiting_credential and hands back no session', async () => {
    const h = harness();
    const opened = await openLogin(h);

    expect(opened.state).toBe(AuthFlowState.AWAITING_CREDENTIAL);
    expect(opened.message).toBe(FlowMessage.AWAITING_CREDENTIAL);
    expect(opened.retryable).toBe(true);
    expect(opened.session).toBeNull();
    expect(h.flows.rows.get(opened.flowId)?.status).toBe(AuthFlowState.AWAITING_CREDENTIAL);
  });

  it('reaches completed on the right password and issues a session', async () => {
    const h = harness();
    const opened = await openLogin(h);

    const done = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, PASSWORD),
    );

    expect(done.state).toBe(AuthFlowState.COMPLETED);
    expect(done.message).toBe(FlowMessage.COMPLETED);
    expect(done.retryable).toBe(false);
    expect(done.session?.accessToken).toBe('access.1');
    expect(done.session?.sessionId).toBe('session-1');
    expect(h.sessions.issued).toEqual([{ userId: USER_ID, email: EMAIL }]);
  });

  it('reaches failed on the wrong password, and says so identically to an unknown user', async () => {
    const known = harness();
    const unknown = harness();

    const wrongUser = await known.start.execute(
      new StartFlowCommand(AuthFlowType.LOGIN, EMAIL),
    );
    const wrongPassword = await known.advance.execute(
      new AdvanceFlowCommand(wrongUser.flowId, 'not the password'),
    );

    const noSuchUser = await unknown.start.execute(
      new StartFlowCommand(AuthFlowType.LOGIN, 'nobody@example.com'),
    );
    const emptyPassword = await unknown.advance.execute(
      new AdvanceFlowCommand(noSuchUser.flowId, 'whatever'),
    );

    expect(wrongPassword.state).toBe(AuthFlowState.FAILED);
    expect(emptyPassword.state).toBe(AuthFlowState.FAILED);
    // The two refusals are indistinguishable apart from the flow id: same state, same message,
    // same retryability. That is the property that keeps sign-in from being an account oracle.
    expect(wrongPassword.message).toBe(emptyPassword.message);
    expect(wrongPassword.message).toBe(FlowMessage.FAILED);
    expect(wrongPassword.retryable).toBe(emptyPassword.retryable);
    expect(wrongPassword.session).toBeNull();
    expect(emptyPassword.session).toBeNull();
  });

  it('never spends a password check on an unknown account', async () => {
    const h = harness();
    const opened = await h.start.execute(
      new StartFlowCommand(AuthFlowType.LOGIN, 'nobody@example.com'),
    );

    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, 'whatever'));

    expect(h.credentials.calls).toHaveLength(0);
  });

  it('records the failure reason even though the message does not', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, 'wrong'));

    const row = h.flows.rows.get(opened.flowId);
    expect(row?.failure_reason).toBe('invalid_credentials');
    expect(row?.status).toBe(AuthFlowState.FAILED);
  });

  it('refuses an empty credential without asking the vault', async () => {
    const h = harness();
    const opened = await openLogin(h);

    const done = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, '   '));

    expect(done.state).toBe(AuthFlowState.FAILED);
    expect(h.credentials.calls).toHaveLength(0);
  });

  it('records the steps it ran', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    const flow = await h.flows.findById(opened.flowId);
    expect(flow).not.toBeNull();
    expect(describeSteps(flow?.steps ?? [])).toEqual([
      'created -> awaiting_credential (started)',
      'awaiting_credential -> completed (two_factor_verified)',
    ]);
  });
});

// ---- login with a second factor -------------------------------------------------

describe('login with MFA enabled', () => {
  it('pauses at awaiting_2fa and asks mfa whether a factor is enrolled', async () => {
    const h = harness();
    h.mfa.enabled = true;
    const opened = await openLogin(h);

    const paused = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, PASSWORD),
    );

    expect(paused.state).toBe(AuthFlowState.AWAITING_2FA);
    expect(paused.message).toBe(FlowMessage.AWAITING_2FA);
    expect(paused.session).toBeNull();
    expect(h.sessions.issued).toHaveLength(0);
    expect(h.mfa.isEnabledCalls).toEqual([USER_ID]);
  });

  it('completes after the code and issues the session then, not before', async () => {
    const h = harness();
    h.mfa.enabled = true;
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    const done = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    expect(done.state).toBe(AuthFlowState.COMPLETED);
    expect(done.session?.accessToken).toBe('access.1');
    expect(h.sessions.issued).toHaveLength(1);
    expect(h.mfa.verifyCalls).toEqual([{ userId: USER_ID, code: CODE }]);
  });

  it('records both proof steps in the audit trail', async () => {
    const h = harness();
    h.mfa.enabled = true;
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    const flow = await h.flows.findById(opened.flowId);
    expect(flow).not.toBeNull();
    expect(describeSteps(flow?.steps ?? [])).toEqual([
      'created -> awaiting_credential (started)',
      'awaiting_credential -> awaiting_2fa (credential_verified)',
      'awaiting_2fa -> completed (two_factor_verified)',
    ]);
  });

  it('fails the flow on a wrong code', async () => {
    const h = harness();
    h.mfa.enabled = true;
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    const refused = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, '000000'),
    );

    expect(refused.state).toBe(AuthFlowState.FAILED);
    expect(refused.session).toBeNull();
    expect(h.flows.rows.get(opened.flowId)?.failure_reason).toBe('invalid_second_factor');
  });

  it('skips the second factor entirely when mfa reports none enrolled', async () => {
    const h = harness();
    h.mfa.enabled = false;
    const opened = await openLogin(h);

    const done = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, PASSWORD),
    );

    expect(done.state).toBe(AuthFlowState.COMPLETED);
    expect(h.mfa.verifyCalls).toHaveLength(0);
  });
});

// ---- step-up --------------------------------------------------------------------

describe('step-up', () => {
  const openStepUp = (h: Harness): Promise<FlowOutcome> =>
    h.start.execute(new StartFlowCommand(AuthFlowType.STEP_UP, '', USER_ID));

  it('opens directly in awaiting_step_up, never in awaiting_credential', async () => {
    const h = harness();
    const opened = await openStepUp(h);

    expect(opened.state).toBe(AuthFlowState.AWAITING_STEP_UP);
    expect(opened.message).toBe(FlowMessage.AWAITING_STEP_UP);
  });

  it('completes after the factor is proved', async () => {
    const h = harness();
    const opened = await openStepUp(h);

    const done = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    expect(done.state).toBe(AuthFlowState.COMPLETED);
    expect(h.mfa.verifyCalls).toEqual([{ userId: USER_ID, code: CODE }]);
  });

  it('does NOT issue a session', async () => {
    const h = harness();
    const opened = await openStepUp(h);

    const done = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    expect(done.session).toBeNull();
    expect(h.sessions.issued).toHaveLength(0);
    expect(h.identity.byIdCalls).toHaveLength(0);
  });

  it('never asks for a password, however many times it is advanced', async () => {
    const h = harness();
    const opened = await openStepUp(h);

    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    expect(h.credentials.calls).toHaveLength(0);
  });

  it('fails the flow when the factor is refused', async () => {
    const h = harness();
    const opened = await openStepUp(h);

    const refused = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, '000000'),
    );

    expect(refused.state).toBe(AuthFlowState.FAILED);
    expect(h.flows.rows.get(opened.flowId)?.failure_reason).toBe('invalid_step_up');
    expect(h.sessions.issued).toHaveLength(0);
  });

  it('refuses to start without naming whose account it is for', async () => {
    const h = harness();
    await expect(
      h.start.execute(new StartFlowCommand(AuthFlowType.STEP_UP, '')),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('does not look an address up', async () => {
    const h = harness();
    await openStepUp(h);
    expect(h.identity.byEmailCalls).toHaveLength(0);
  });
});

// ---- expiry ---------------------------------------------------------------------

describe('expiry', () => {
  it('refuses to advance and records why it stopped', async () => {
    const h = harness();
    const opened = await openLogin(h);

    h.clock.advance(FLOW_TTL_MS + 1);
    const done = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, PASSWORD),
    );

    expect(done.state).toBe(AuthFlowState.EXPIRED);
    expect(done.message).toBe(FlowMessage.EXPIRED);
    expect(done.retryable).toBe(false);
    expect(done.session).toBeNull();
    expect(h.flows.rows.get(opened.flowId)?.status).toBe(AuthFlowState.EXPIRED);
  });

  it('spends no downstream call on an expired flow', async () => {
    const h = harness();
    const opened = await openLogin(h);

    h.clock.advance(FLOW_TTL_MS + 1);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    expect(h.credentials.calls).toHaveLength(0);
    expect(h.sessions.issued).toHaveLength(0);
  });

  it('records the expiry as a step', async () => {
    const h = harness();
    const opened = await openLogin(h);

    h.clock.advance(FLOW_TTL_MS + 1);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    const flow = await h.flows.findById(opened.flowId);
    expect(flow).not.toBeNull();
    expect(describeSteps(flow?.steps ?? [])).toEqual([
      'created -> awaiting_credential (started)',
      'awaiting_credential -> expired (expired)',
    ]);
  });

  it('cannot be advanced again once it has expired', async () => {
    const h = harness();
    const opened = await openLogin(h);

    h.clock.advance(FLOW_TTL_MS + 1);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    await expect(
      h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD)),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
  });

  it('is still advanceable one millisecond before the TTL', async () => {
    const h = harness();
    const opened = await openLogin(h);

    h.clock.advance(FLOW_TTL_MS - 1);
    const done = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, PASSWORD),
    );

    expect(done.state).toBe(AuthFlowState.COMPLETED);
  });
});

// ---- cannot advance a finished flow --------------------------------------------

describe('a finished flow', () => {
  it('cannot be advanced after completion', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    await expect(
      h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD)),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    expect(h.sessions.issued).toHaveLength(1);
  });

  it('cannot be advanced after failure', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, 'wrong'));

    await expect(
      h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD)),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    expect(h.flows.rows.get(opened.flowId)?.status).toBe(AuthFlowState.FAILED);
  });

  it('cannot be advanced after cancellation', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.cancel.execute(new CancelFlowCommand(opened.flowId, 'walked away'));

    await expect(
      h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD)),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    expect(h.flows.rows.get(opened.flowId)?.status).toBe(AuthFlowState.CANCELLED);
  });
});

// ---- cancel ---------------------------------------------------------------------

describe('cancel', () => {
  it('moves an open flow to cancelled and records the reason', async () => {
    const h = harness();
    const opened = await openLogin(h);

    const cancelled = await h.cancel.execute(
      new CancelFlowCommand(opened.flowId, 'the person closed the tab'),
    );

    expect(cancelled.state).toBe(AuthFlowState.CANCELLED);
    expect(cancelled.message).toBe(FlowMessage.CANCELLED);
    const row = h.flows.rows.get(opened.flowId);
    expect(row?.status).toBe(AuthFlowState.CANCELLED);
    expect(row?.abort_reason).toBe('the person closed the tab');
  });

  it('is refused a second time rather than silently repeated', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.cancel.execute(new CancelFlowCommand(opened.flowId, 'walked away'));

    await expect(
      h.cancel.execute(new CancelFlowCommand(opened.flowId, 'walked away')),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
  });

  it('is refused for a flow that already completed', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    await expect(
      h.cancel.execute(new CancelFlowCommand(opened.flowId, 'too late')),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
  });
});

// ---- the attempt budget ---------------------------------------------------------

describe('the attempt budget', () => {
  it('fails the flow once the row has been spent', async () => {
    const h = harness({ maxAttempts: 1 });
    const opened = await openLogin(h);

    // First use spends the single attempt and fails on its own merits.
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    const row = h.flows.rows.get(opened.flowId);
    expect(row?.attempt_count).toBe(1);
    expect(row?.max_attempts).toBe(1);
  });

  it('refuses a second use of a row whose budget is gone', async () => {
    const h = harness({ maxAttempts: 1 });
    const opened = await h.start.execute(
      new StartFlowCommand(AuthFlowType.REGISTER, 'brand.new@example.com'),
    );
    // Reaching awaiting_2fa costs the row its one attempt without finishing it.
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, 'the password'));

    const refused = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    expect(refused.state).toBe(AuthFlowState.FAILED);
    expect(h.flows.rows.get(opened.flowId)?.failure_reason).toBe(MAX_ATTEMPTS_REASON);
    expect(h.mfa.verifyCalls).toHaveLength(0);
    expect(h.sessions.issued).toHaveLength(0);
  });
});

// ---- magic link -----------------------------------------------------------------

describe('magic_link', () => {
  it('completes when the link is presented, and issues a session', async () => {
    const h = harness();
    const opened = await h.start.execute(
      new StartFlowCommand(AuthFlowType.MAGIC_LINK, EMAIL),
    );

    expect(opened.state).toBe(AuthFlowState.AWAITING_CREDENTIAL);

    const done = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, 'magic-token'),
    );

    expect(done.state).toBe(AuthFlowState.COMPLETED);
    expect(done.session?.accessToken).toBe('access.1');
    // The link is a capability, not a password: nothing is sent to the vault.
    expect(h.credentials.calls).toHaveLength(0);
    expect(h.mfa.isEnabledCalls).toHaveLength(0);
  });

  it('refuses an empty link', async () => {
    const h = harness();
    const opened = await h.start.execute(
      new StartFlowCommand(AuthFlowType.MAGIC_LINK, EMAIL),
    );

    const done = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, ''));

    expect(done.state).toBe(AuthFlowState.FAILED);
    expect(h.sessions.issued).toHaveLength(0);
  });
});

// ---- reset password -------------------------------------------------------------

describe('reset_password', () => {
  const openReset = (h: Harness): Promise<FlowOutcome> =>
    h.start.execute(new StartFlowCommand(AuthFlowType.RESET_PASSWORD, EMAIL));

  it('pauses for a second factor after the password is proved', async () => {
    const h = harness();
    const opened = await openReset(h);

    const paused = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, PASSWORD),
    );

    expect(paused.state).toBe(AuthFlowState.AWAITING_2FA);
    expect(h.sessions.issued).toHaveLength(0);
  });

  it('completes after the code without issuing a session', async () => {
    const h = harness();
    const opened = await openReset(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    const done = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    expect(done.state).toBe(AuthFlowState.COMPLETED);
    expect(done.session).toBeNull();
    expect(h.sessions.issued).toHaveLength(0);
  });

  it('never asks mfa whether a factor is enrolled — the mailbox is the factor', async () => {
    const h = harness();
    h.mfa.enabled = true;
    const opened = await openReset(h);

    const paused = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, PASSWORD),
    );

    expect(paused.state).toBe(AuthFlowState.AWAITING_2FA);
    expect(h.mfa.isEnabledCalls).toHaveLength(0);
  });

  it('fails on a wrong password without naming the address', async () => {
    const h = harness();
    const opened = await openReset(h);

    const refused = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, 'wrong'),
    );

    expect(refused.state).toBe(AuthFlowState.FAILED);
    expect(refused.message).toBe(FlowMessage.FAILED);
    expect(h.flows.rows.get(opened.flowId)?.failure_reason).toBe('invalid_credentials');
  });
});

// ---- register -------------------------------------------------------------------

describe('register', () => {
  it('goes straight to a second factor, because there is no account to check a password against', async () => {
    const h = harness();
    const opened = await h.start.execute(
      new StartFlowCommand(AuthFlowType.REGISTER, 'brand.new@example.com'),
    );

    const paused = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, 'the chosen password'),
    );

    expect(paused.state).toBe(AuthFlowState.AWAITING_2FA);
    expect(h.credentials.calls).toHaveLength(0);
    expect(h.sessions.issued).toHaveLength(0);
  });

  it('completes after the code, without issuing a session', async () => {
    const h = harness();
    const opened = await h.start.execute(
      new StartFlowCommand(AuthFlowType.REGISTER, 'brand.new@example.com'),
    );
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, 'the chosen password'));

    const done = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    expect(done.state).toBe(AuthFlowState.COMPLETED);
    expect(done.session).toBeNull();
    expect(h.sessions.issued).toHaveLength(0);
  });

  it('refuses an address that already has an account, with the same answer as anything else', async () => {
    const h = harness();
    const taken = await h.start.execute(
      new StartFlowCommand(AuthFlowType.REGISTER, EMAIL),
    );
    const refused = await h.advance.execute(
      new AdvanceFlowCommand(taken.flowId, 'the chosen password'),
    );

    const h2 = harness();
    const unknown = await h2.start.execute(
      new StartFlowCommand(AuthFlowType.LOGIN, 'nobody@example.com'),
    );
    const alsoRefused = await h2.advance.execute(
      new AdvanceFlowCommand(unknown.flowId, 'whatever'),
    );

    expect(refused.state).toBe(AuthFlowState.FAILED);
    // Same public answer, different recorded reason: an operator can tell an enumeration
    // attempt from a mistyped password; the person at the keyboard cannot.
    expect(refused.message).toBe(alsoRefused.message);
    expect(h.flows.rows.get(taken.flowId)?.failure_reason).toBe('account_unavailable');
    expect(h2.flows.rows.get(unknown.flowId)?.failure_reason).toBe('invalid_credentials');
  });
});

// ---- reads and refusals ---------------------------------------------------------

describe('get flow', () => {
  it('reports where the flow is, without a session', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    const read = await h.get.execute(new GetFlowQuery(opened.flowId));

    expect(read?.state).toBe(AuthFlowState.COMPLETED);
    expect(read?.flowId).toBe(opened.flowId);
    // A page reloaded half-way through a sign-in must not be able to go back and collect the
    // tokens it never earned.
    expect(read?.session).toBeNull();
  });

  it('returns null for an id that does not exist', async () => {
    const h = harness();
    expect(await h.get.execute(new GetFlowQuery('no-such-flow'))).toBeNull();
  });
});

describe('refusals', () => {
  it('rejects an unknown flow type', async () => {
    const h = harness();
    await expect(
      h.start.execute(new StartFlowCommand('telepathy', EMAIL)),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('reports an unknown flow id as not found', async () => {
    const h = harness();
    await expect(
      h.advance.execute(new AdvanceFlowCommand('no-such-flow', PASSWORD)),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('reports an unknown flow id as not found on cancel', async () => {
    const h = harness();
    await expect(
      h.cancel.execute(new CancelFlowCommand('no-such-flow', 'because')),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});

// ---- the outbox boundary --------------------------------------------------------

describe('published events', () => {
  it('carries no password and no token', async () => {
    const h = harness();
    h.mfa.enabled = true;
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    const serialised = JSON.stringify(h.flows.published);

    expect(h.flows.published.map((event) => event.eventType)).toEqual([
      'auth_flow.started',
      'auth_flow.step_completed',
      'auth_flow.step_completed',
      'auth_flow.completed',
    ]);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(CODE);
    expect(serialised).not.toContain('access.1');
    expect(serialised).not.toContain('refresh.1');
  });

  it('scopes every event to the flow as the partition key', async () => {
    const h = harness();
    const opened = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    for (const event of h.flows.published) {
      expect(event.aggregateId).toBe(opened.flowId);
      expect(event.aggregateType).toBe('AuthFlow');
    }
  });
});

// ---- account lockout -------------------------------------------------------------

/** The address a flow arrived from. Without it nothing is reported to account-security. */
const CLIENT_IP = '203.0.113.9';

describe('account lockout', () => {
  /** The same harness, with account-security wired into the advance handler. */
  const securedHarness = (): Harness & { security: FakeAccountSecurity } => {
    const h = harness();
    const security = new FakeAccountSecurity();
    return {
      ...h,
      security,
      advance: new AdvanceFlowHandler(
        h.flows,
        h.identity,
        h.credentials,
        h.mfa,
        h.sessions,
        h.clock,
        security,
      ),
    };
  };

  const loginFrom = (h: Harness, clientIp?: string): Promise<FlowOutcome> =>
    h.start.execute(new StartFlowCommand(AuthFlowType.LOGIN, EMAIL, undefined, clientIp));

  it('reports a completed sign-in so the counters behind it can be cleared', async () => {
    const h = securedHarness();
    const opened = await loginFrom(h, CLIENT_IP);

    const outcome = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    expect(outcome.state).toBe(AuthFlowState.COMPLETED);
    expect(h.security.attempts).toEqual([
      { userId: USER_ID, email: '', ipAddress: CLIENT_IP, succeeded: true },
    ]);
  });

  it('reports a failed sign-in as locked, together with how long to wait', async () => {
    const h = securedHarness();
    h.security.lock = { locked: true, lockedUntil: Date.now() + 900_000, retryAfterSeconds: 900 };
    const opened = await loginFrom(h, CLIENT_IP);

    const outcome = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, 'not the password'),
    );

    // The lock is state, not an error: `state` is still `failed`, and the two extra fields are
    // what let an edge answer 423 instead of collapsing to a status gRPC has no word for. The
    // message stays the shared refusal string so a locked account still reads like any other.
    expect(outcome.state).toBe(AuthFlowState.FAILED);
    expect(outcome.message).toBe(FlowMessage.FAILED);
    expect(outcome.locked).toBe(true);
    expect(outcome.retryAfterSeconds).toBe(900);
  });

  it('reports no lock alongside a completed sign-in, which has just cleared it', async () => {
    const h = securedHarness();
    h.security.lock = { locked: true, lockedUntil: Date.now() + 900_000, retryAfterSeconds: 900 };
    const opened = await loginFrom(h, CLIENT_IP);

    const outcome = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    expect(outcome.state).toBe(AuthFlowState.COMPLETED);
    expect(outcome.locked).toBe(false);
    expect(outcome.retryAfterSeconds).toBe(0);
  });

  it('lets a sign in through when account-security cannot be reached', async () => {
    const h = securedHarness();
    h.security.unreachableReason = 'connect ECONNREFUSED 10.0.0.7:31007';
    const opened = await loginFrom(h, CLIENT_IP);

    const outcome = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    expect(outcome.state).toBe(AuthFlowState.COMPLETED);
  });

  it('still refuses a wrong password when account-security cannot be reached', async () => {
    const h = securedHarness();
    h.security.unreachableReason = 'connect ECONNREFUSED 10.0.0.7:31007';
    const opened = await loginFrom(h, CLIENT_IP);

    const outcome = await h.advance.execute(
      new AdvanceFlowCommand(opened.flowId, 'not the password'),
    );

    // The failure mode of the dependency must not turn into a failure mode of the protocol.
    // An outage in the audit path would otherwise present as a broken sign-in endpoint.
    expect(outcome.state).toBe(AuthFlowState.FAILED);
    expect(outcome.message).toBe(FlowMessage.FAILED);
  });

  it('asks nothing when the flow carries no address, since there is nothing to count against', async () => {
    const h = securedHarness();
    const opened = await loginFrom(h);

    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    expect(h.security.attempts).toEqual([]);
  });

  it('does not record a registration as a sign-in', async () => {
    const h = securedHarness();
    const opened = await h.start.execute(
      new StartFlowCommand(AuthFlowType.REGISTER, 'brand.new@example.com', undefined, CLIENT_IP),
    );

    await h.advance.execute(new AdvanceFlowCommand(opened.flowId, CODE));

    expect(h.security.attempts).toEqual([]);
  });

  it('walks the flow when account-security was never wired', async () => {
    // The port is optional so that a focused deployment — or a suite about state — can run
    // without this peer. Wires it: the handler must not need a container to decide.
    const h = harness();
    const opened = await loginFrom(h, CLIENT_IP);

    const outcome = await h.advance.execute(new AdvanceFlowCommand(opened.flowId, PASSWORD));

    expect(outcome.state).toBe(AuthFlowState.COMPLETED);
  });
});

// ---- the health probe -----------------------------------------------------------

describe('health', () => {
  it('counts the flows that are still open', async () => {
    const h = harness();
    await openLogin(h);
    const second = await openLogin(h);
    await h.advance.execute(new AdvanceFlowCommand(second.flowId, PASSWORD));

    expect(await h.flows.countActive(T0)).toBe(1);
    expect(await h.flows.countActive(new Date(T0.getTime() + FLOW_TTL_MS * 2))).toBe(0);
  });
});