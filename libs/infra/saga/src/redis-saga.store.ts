import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '@auth/infra/redis';
import { isTerminal, type SagaStatus } from './saga.config';
import {
  SagaConflictError,
  type SagaInstance,
  type SagaStorePort,
} from './saga.store.port';

const INSTANCE_KEY = (sagaId: string): string => `saga:instance:${sagaId}`;
const ACTIVE_SET = 'saga:active';

/**
 * The compare-and-set, as one Lua script.
 *
 * @remarks Two round trips — read the stored version, then write — is a race: two recovery
 * sweepers both read `version = 4`, both decide they hold `5`, and both drive the saga. The
 * check and the write happen atomically here or not at all. Terminal instances leave the
 * active set and pick up a TTL so the keyspace does not grow with every saga ever run.
 */
const SAVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local incomingVersion = tonumber(ARGV[2])

if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and decoded and decoded.version ~= incomingVersion - 1 then
    return 0
  end
end

redis.call('SET', KEYS[1], ARGV[1])

if ARGV[4] == '1' then
  redis.call('ZREM', KEYS[2], ARGV[5])
  redis.call('PEXPIRE', KEYS[1], ARGV[6])
else
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[5])
end

return 1
`;

/**
 * Durable saga store on the platform's Redis.
 *
 * @remarks One JSON string per instance plus a sorted set of the in-flight ids scored by
 * `updatedAt`. The set is what makes `findInterrupted` a range query instead of a keyspace
 * scan, and it stays small because terminal instances are removed the moment they settle.
 */
@Injectable()
export class RedisSagaStore implements SagaStorePort {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly retentionHours: number,
  ) {}

  async save(instance: SagaInstance): Promise<void> {
    const terminal = isTerminal(instance.status);
    const result = await this.redis.eval(
      SAVE_SCRIPT,
      2,
      INSTANCE_KEY(instance.sagaId),
      ACTIVE_SET,
      JSON.stringify(instance),
      String(instance.version),
      String(instance.updatedAt.getTime()),
      terminal ? '1' : '0',
      instance.sagaId,
      String(this.retentionHours * 3_600_000),
    );

    if (Number(result) !== 1) {
      const stored = await this.findById(instance.sagaId);
      throw new SagaConflictError(
        instance.sagaId,
        stored?.version ?? 0,
      );
    }
  }

  async findById(sagaId: string): Promise<SagaInstance | null> {
    const raw = await this.redis.get(INSTANCE_KEY(sagaId));
    if (raw === null) return null;
    return revive(JSON.parse(raw) as Record<string, unknown>);
  }

  async findInterrupted(olderThan: Date): Promise<SagaInstance[]> {
    const ids = await this.redis.zrangebyscore(
      ACTIVE_SET,
      '-inf',
      String(olderThan.getTime()),
    );
    if (ids.length === 0) return [];

    const keys = ids.map(INSTANCE_KEY);
    const raws = await this.redis.mget(keys);
    return raws
      .filter((raw): raw is string => raw !== null)
      .map((raw) => revive(JSON.parse(raw) as Record<string, unknown>))
      .filter((instance) => !isTerminal(instance.status));
  }

  async countByStatus(status: SagaStatus): Promise<number> {
    // The active set holds every non-terminal instance; the population is bounded by the
    // in-flight sagas, so counting by loading them is cheaper than a second index to keep.
    const ids = await this.redis.zrange(ACTIVE_SET, '0', '-1');
    if (ids.length === 0) return 0;

    const raws = await this.redis.mget(ids.map(INSTANCE_KEY));
    let count = 0;
    for (const raw of raws) {
      if (raw === null) continue;
      const parsed = JSON.parse(raw) as { status?: unknown };
      if (parsed.status === status) count += 1;
    }
    return count;
  }
}

/** JSON round-trips Dates to strings; this puts them back where the runner expects them. */
function revive(record: Record<string, unknown>): SagaInstance {
  return {
    sagaId: record['sagaId'] as string,
    sagaType: record['sagaType'] as string,
    status: record['status'] as SagaStatus,
    stepIndex: record['stepIndex'] as number,
    context: record['context'] as Record<string, unknown>,
    attempts: record['attempts'] as number,
    lastError: (record['lastError'] as string | null) ?? null,
    ...(record['correlationId']
      ? { correlationId: record['correlationId'] as string }
      : {}),
    version: record['version'] as number,
    startedAt: new Date(record['startedAt'] as string),
    updatedAt: new Date(record['updatedAt'] as string),
    completedAt: record['completedAt']
      ? new Date(record['completedAt'] as string)
      : null,
  };
}
