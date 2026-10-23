/**
 * @fileoverview `Kafka` transport security: how plaintext MSK-free development and
 * IAM-authenticated MSK Serverless share one config surface.
 *
 * @remarks The parser half is about the operator-facing contract — defaults, the
 * `KAFKA_SSL` / `KAFKA_SASL_MECHANISM` knobs, and a boot-stopping error for a mechanism
 * nobody supports. The `clientSecurity` half is about what reaches `new Kafka(...)`: no
 * options at all when off, TLS alone when requested, and an `oauthbearer` provider that
 * signs on demand — with a fail-fast when `AWS_REGION` is missing, because a service that
 * boots into an unusable broker list fails far later and far more obscurely.
 */
import { readNamespacedEnv } from '@auth/platform/config';
import { clientSecurity, ENV_PREFIX, kafkaSchema, type KafkaConfig } from '../src/kafka.config';

jest.mock('aws-msk-iam-sasl-signer-js', () => ({
  generateAuthToken: jest.fn().mockResolvedValue({ token: 'signed-token' }),
}));

const config = (over: Partial<KafkaConfig> = {}): KafkaConfig => ({
  enabled: true,
  brokers: ['localhost:9092'],
  clientId: 'auth-service',
  groupId: 'auth-consumer',
  acks: -1,
  retries: 5,
  maxBytes: 1_048_576,
  maxWaitMs: 5_000,
  sessionTimeoutMs: 30_000,
  maxAttempts: 5,
  retryBaseMs: 1_000,
  ssl: false,
  saslMechanism: 'none',
  ...over,
});

describe('kafkaSchema transport security', () => {
  const parse = (env: Record<string, string | undefined>) =>
    readNamespacedEnv(ENV_PREFIX, kafkaSchema, env);

  it('defaults to plaintext without SASL', () => {
    const parsed = parse({});
    expect(parsed.SSL).toBe(false);
    expect(parsed.SASL_MECHANISM).toBe('none');
  });

  it('reads KAFKA_SSL and KAFKA_SASL_MECHANISM from the namespace', () => {
    const parsed = parse({ KAFKA_SSL: 'true', KAFKA_SASL_MECHANISM: 'oauthbearer' });
    expect(parsed.SSL).toBe(true);
    expect(parsed.SASL_MECHANISM).toBe('oauthbearer');
  });

  it('rejects a mechanism kafkajs cannot authenticate with', () => {
    expect(() => parse({ KAFKA_SASL_MECHANISM: 'scram-sha-256' })).toThrow(
      /KAFKA_SASL_MECHANISM/,
    );
  });

  it('rejects a non-boolean KAFKA_SSL', () => {
    // `envBoolean` throws from inside its transform, so the message bypasses the
    // `readNamespacedEnv` `PREFIX_` formatting that enum issues go through.
    expect(() => parse({ KAFKA_SSL: 'yep' })).toThrow(/Expected a boolean/);
  });
});

describe('clientSecurity', () => {
  let savedRegion: string | undefined;

  beforeEach(() => {
    savedRegion = process.env.AWS_REGION;
    delete process.env.AWS_REGION;
  });

  afterEach(() => {
    if (savedRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = savedRegion;
  });

  it('returns no options when both knobs are off', () => {
    expect(clientSecurity(config())).toEqual({});
  });

  it('enables TLS without touching SASL when only SSL is set', () => {
    expect(clientSecurity(config({ ssl: true }))).toEqual({ ssl: true });
  });

  it('refuses to build oauthbearer options without AWS_REGION', () => {
    expect(() => clientSecurity(config({ saslMechanism: 'oauthbearer' }))).toThrow(
      /AWS_REGION/,
    );
  });

  it('signs an oauthbearer token through the AWS credential chain', async () => {
    process.env.AWS_REGION = 'eu-central-1';

    const security = clientSecurity(config({ ssl: true, saslMechanism: 'oauthbearer' }));

    expect(security.ssl).toBe(true);
    expect(security.sasl).toMatchObject({ mechanism: 'oauthbearer' });

    const provider = (
      security.sasl as { oauthBearerProvider: () => Promise<{ value: string }> }
    ).oauthBearerProvider;
    // kafkajs invokes this per (re)connection, which is why the token is not cached here.
    await expect(provider()).resolves.toEqual({ value: 'signed-token' });
  });
});
