/**
 * @fileoverview Guest acquisition at the edge: a pass-through with no opinion of its own.
 *
 * @remarks The interesting property is the *absence* of a decision. Whether a presented id
 * may be honoured is identity's call, made against the row — an edge that checked anything
 * here would be checking a copy of a fact it does not own. These tests therefore assert
 * exactly what crosses the boundary: the id goes in untouched, and a peer refusal comes back
 * out unaltered rather than being answered with a placeholder of the edge's own.
 */
import { GatewayService } from '../src/application/facade/gateway.service';
import {
  FakeAccessControlClient,
  FakeAuthFlowClient,
  FakeCredentialVaultClient,
  FakeIdentityClient,
  FakeSessionClient,
  USER_ID,
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

  return { service, identity };
};

describe('GatewayService.acquireGuestUser', () => {
  it('presents no id on a first visit', async () => {
    const { service, identity } = serviceWith();

    await service.acquireGuestUser();

    expect(identity.acquired).toEqual([undefined]);
  });

  it('hands the presented id to identity untouched', async () => {
    const { service, identity } = serviceWith();

    await service.acquireGuestUser(USER_ID);

    // Untouched is the assertion: the edge does not trim, normalise or re-derive it, so no
    // disagreement can arise between what the browser sent and what identity judged.
    expect(identity.acquired).toEqual([USER_ID]);
  });

  it('returns the user identity answered with', async () => {
    const { service, identity } = serviceWith();

    await expect(service.acquireGuestUser()).resolves.toEqual(identity.user);
  });

  it('surfaces a peer refusal instead of substituting a placeholder', async () => {
    const { service, identity } = serviceWith();
    const refusal = new Error('identity unreachable');
    identity.acquireError = refusal;

    const error = await service.acquireGuestUser().catch((e: unknown) => e);

    // A silent fallback to a fresh guest here would turn an outage into two placeholders
    // per browser, and would hide from the caller that its old id went unjudged.
    expect(error).toBe(refusal);
    expect(identity.acquired).toEqual([undefined]);
  });
});
