/**
 * @fileoverview The readiness probe: what "can this service still answer a GetCart?"
 * reports, and why it answers rather than throws.
 *
 * @remarks The probe calls the store rather than the socket, because that is the question
 * a readiness check actually cares about: not "is Redis open" but "would a basket come
 * back". A probe that only opened a connection would report green on a deployment with no
 * `REDIS_URL` at all — which is precisely the state in which every cart request fails.
 *
 * @remarks Never throws. A health check that raises turns one sick dependency into an
 * error on the health endpoint itself, and the two become indistinguishable.
 */
import { CartHealthIndicator } from '../src/cart.health';
import { RedisCartStore } from '../src/infrastructure/persistence/redis-cart.store';
import { InMemoryCartStore, testCartConfig } from './support/fakes';

describe('CartHealthIndicator', () => {
  it('reports up with a latency once the store answers', async () => {
    const health = await new CartHealthIndicator(new InMemoryCartStore()).check();

    expect(health['cart']).toMatchObject({
      status: 'up',
      latencyMs: expect.any(Number),
    });
  });

  it('reports down when Redis was never configured, naming the reason', async () => {
    // The real store with no client — the state `REDIS_URL` unset produces. A probe that
    // only opened a socket would call this healthy.
    const store = new RedisCartStore(null, testCartConfig());

    const health = await new CartHealthIndicator(store).check();

    expect(health['cart']).toMatchObject({
      status: 'down',
      message: expect.stringContaining('REDIS_URL is not set'),
    });
  });

  it('reports down when the store cannot be reached, without raising', async () => {
    const store = new InMemoryCartStore();
    store.failure = new Error('the cart store could not be reached');

    const health = await new CartHealthIndicator(store).check();

    expect(health['cart']).toMatchObject({
      status: 'down',
      message: 'the cart store could not be reached',
    });
  });
});
