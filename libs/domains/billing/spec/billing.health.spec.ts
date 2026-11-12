/**
 * @fileoverview The readiness probe: what "can this service still answer a charge?"
 * reports, and why it answers rather than throws.
 *
 * @remarks The probe counts payments — the table the charge path writes — because that is
 * the question a readiness check actually cares about: not "is the socket open" but "would
 * a charge land". A failure therefore reports `down` with the message instead of throwing:
 * a health endpoint that raises turns one slow dependency into every replica being pulled
 * from the load balancer, which is the outage amplifier the base class exists to prevent.
 */
import { BillingHealthIndicator } from '../src/billing.health';
import { Payment } from '../src/domain/payment.entity';
import { InMemoryBillingRepository, ORDER_ID, PAYMENT_ID } from './support/fakes';

const seededPayment = (): Payment =>
  Payment.fromProvider({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    idempotencyKey: `order:${ORDER_ID}:charge:1`,
    amountMinor: 2_000,
    currency: 'EUR',
    status: 'succeeded',
    provider: 'fake',
    providerRef: 'psp_ch_probe',
    customerId: 'customer-1',
  });

describe('BillingHealthIndicator', () => {
  it('reports up with the payment count and a latency once a charge has landed', async () => {
    const repository = new InMemoryBillingRepository();
    repository.payments.set(PAYMENT_ID, seededPayment());

    const health = await new BillingHealthIndicator(repository).check();

    expect(health['billing']).toMatchObject({
      status: 'up',
      payments: 1,
      latencyMs: expect.any(Number),
    });
  });

  it('reports up at zero for a service nobody has charged through yet', async () => {
    // A fresh deployment is not an incident. Reporting `down` at zero payments would take
    // every new replica out of the load balancer exactly when it is needed most.
    const health = await new BillingHealthIndicator(new InMemoryBillingRepository()).check();

    expect(health['billing']).toMatchObject({ status: 'up', payments: 0 });
  });

  it('reports down with the failure rather than throwing', async () => {
    const repository = new InMemoryBillingRepository();
    jest
      .spyOn(repository, 'countPayments')
      .mockRejectedValueOnce(new Error('the database is unreachable'));

    const health = await new BillingHealthIndicator(repository).check();

    expect(health['billing']).toMatchObject({
      status: 'down',
      message: 'the database is unreachable',
    });
  });
});
