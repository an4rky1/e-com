/**
 * @fileoverview The read side: devices, history, and a score.
 *
 * @remarks Every query is a class. `QueryBus.execute` resolves a handler from
 * `query.constructor`, and `@QueryHandler('Name')` throws at import because
 * `Reflect.hasOwnMetadata` rejects a non-object.
 *
 * @remarks None of these queries asserts that a user exists. A 404 here would be an
 * account-existence oracle on the one surface that is otherwise indifferent to the question,
 * and the callers that need to know who someone is already asked identity.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import type { AccountSecurityConfig } from '../../account-security.config';
import { ACCOUNT_SECURITY_CONFIG } from '../../account-security.config';
import {
  DEVICE_REGISTRY,
  SECURITY_REPOSITORY,
  type DeviceRegistryPort,
  type DeviceUsage,
  type SecurityRepositoryPort,
} from '../../domain/ports/security-repository.port';
import { FAILURE_TRACKER, type FailureTrackerPort } from '../../domain/ports/failure-tracker.port';
import { RISK_SCORING, type RiskScoringPort } from '../../domain/ports/risk-scoring.port';

import type { RiskLevel } from '../../domain/value-objects/risk-score.vo';
import type { LoginAttemptInput } from '../commands/login-attempt.commands';
import {
  toFingerprint,
  toLocation,
  toRiskAssessmentInput,
  toRiskAssessmentReadModel,
} from './risk-assessment.read-model';

/** One device as a caller may see it. The shape `ListDevicesResponse` is built from. */
export interface DeviceReadModel {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly ipAddress: string | null;
  readonly country: string | null;
  readonly trusted: boolean;
  readonly lastSeenAt: string;
  readonly loginCount: number;
}

/** One login as a caller may see it. */
export interface LoginHistoryReadModel {
  readonly loginId: string;
  readonly sessionId: string | null;
  readonly fingerprint: string;
  readonly country: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly occurredAt: string;
}

export interface LoginHistoryPage {
  readonly entries: readonly LoginHistoryReadModel[];
  readonly limit: number;
}

/** What a caller may see about a score. Deliberately the same four fields the proto carries. */
export interface RiskAssessmentReadModel {
  readonly score: number;
  readonly level: RiskLevel;
  readonly factors: readonly string[];
  readonly recommendations: readonly string[];
}

export class ListDevicesQuery extends Query<readonly DeviceReadModel[]> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly userId: string) {
    super();
  }
}

export class GetLoginHistoryQuery extends Query<LoginHistoryPage> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly limit?: number,
  ) {
    super();
  }
}

/**
 * "How does this login look?" — answered without recording anything.
 *
 * @remarks A query and not a dry-run command because it is asked *before* the credential is
 * checked, by a caller that wants a second factor rather than a refusal. Writing to the login
 * history or the signals table from here would make a read mutate the evidence an incident
 * review depends on.
 */
export class AssessRiskQuery extends Query<RiskAssessmentReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly input: LoginAttemptInput,
    readonly now?: Date,
  ) {
    super();
  }
}

// ---- ListDevices -----------------------------------------------------------------

@Injectable()
@QueryHandler(ListDevicesQuery)
export class ListDevicesHandler
  implements IQueryHandler<ListDevicesQuery, readonly DeviceReadModel[]>
{
  constructor(
    @Inject(SECURITY_REPOSITORY) private readonly repository: SecurityRepositoryPort,
    @Inject(DEVICE_REGISTRY) private readonly registry: DeviceRegistryPort,
  ) {}

  /**
   * Every device an account has signed in from, newest first.
   *
   * @remarks Derived from the login history and then filtered by the registry, which is the
   * only place a revocation lives. Returning a revoked device with `trusted: false` rather than
   * omitting it is deliberate: a user who retires a laptop still wants to see that it is
   * *still trying*, and a list that silently loses rows is a list they stop trusting.
   */
  async execute(query: ListDevicesQuery): Promise<readonly DeviceReadModel[]> {
    const devices = await this.repository.listDevices(query.userId);

    const views = await Promise.all(
      devices.map(async (device) => ({
        device,
        revoked: await this.registry.isRevoked(query.userId, device.fingerprint),
      })),
    );

    return views.map(({ device, revoked }) => toDeviceReadModel(device, revoked));
  }
}

// ---- GetLoginHistory -------------------------------------------------------------

@Injectable()
@QueryHandler(GetLoginHistoryQuery)
export class GetLoginHistoryHandler
  implements IQueryHandler<GetLoginHistoryQuery, LoginHistoryPage>
{
  constructor(
    @Inject(SECURITY_REPOSITORY) private readonly repository: SecurityRepositoryPort,
    @Inject(ACCOUNT_SECURITY_CONFIG) private readonly config: AccountSecurityConfig,
  ) {}

  /**
   * An account's logins, newest first.
   *
   * @remarks Bounded by the config's page size and clamped to its maximum, because the caller
   * is an untrusted gRPC peer and `take: 100000` against an unindexed-by-nothing table is a
   * cheap way to take this service down.
   */
  async execute(query: GetLoginHistoryQuery): Promise<LoginHistoryPage> {
    const limit = Math.min(
      Math.max(1, query.limit ?? this.config.loginHistoryPageSize),
      this.config.maxLoginHistoryPageSize,
    );

    const entries = await this.repository.listLoginHistory(query.userId, { limit });

    return {
      entries: entries.map((entry) => ({
        loginId: entry.loginId,
        sessionId: entry.sessionId,
        fingerprint: entry.fingerprint,
        country: entry.country,
        latitude: entry.location?.latitude ?? null,
        longitude: entry.location?.longitude ?? null,
        occurredAt: entry.occurredAt.toISOString(),
      })),
      limit,
    };
  }
}

// ---- AssessRisk ------------------------------------------------------------------

@Injectable()
@QueryHandler(AssessRiskQuery)
export class AssessRiskHandler
  implements IQueryHandler<AssessRiskQuery, RiskAssessmentReadModel>
{
  private readonly scoring: RiskScoringPort;

  constructor(
    @Inject(SECURITY_REPOSITORY) private readonly repository: SecurityRepositoryPort,
    @Inject(DEVICE_REGISTRY) private readonly registry: DeviceRegistryPort,
    @Inject(FAILURE_TRACKER) private readonly tracker: FailureTrackerPort,
    @Inject(RISK_SCORING) scoring: RiskScoringPort,
    @Inject(ACCOUNT_SECURITY_CONFIG) private readonly config: AccountSecurityConfig,
  ) {
    this.scoring = scoring;
  }

  /**
   * Scores a login that has not happened yet.
   *
   * @remarks Reads the same facts `RecordLoginAttemptHandler` reads, through the same scorer, so
   * the answer a caller pre-flights and the answer recorded afterwards cannot disagree — except
   * for the attempt itself, which has by definition not moved a counter yet. That asymmetry is
   * the honest one: a pre-flight is about the request in front of you.
   */
  async execute(query: AssessRiskQuery): Promise<RiskAssessmentReadModel> {
    const now = query.now ?? new Date();
    const userId = query.input.userId?.trim() || null;

    const fingerprint = toFingerprint(query.input);

    const scope = { userId, ipAddress: query.input.ipAddress?.trim() || null };
    const counters = await this.tracker.load(scope);

    const [knownDevice, previous, usualHours] = await Promise.all([
      // `true` with no user, for the same reason the Redis registry answers `true` for an empty
      // id: there is no device list to be absent from, and calling every unidentified request a
      // "new device" would make the signal fire on all of them and mean nothing.
      userId === null ? Promise.resolve(true) : this.registry.isKnown(userId, fingerprint.value),
      userId === null
        ? Promise.resolve(null)
        : this.repository.lastSeenElsewhere(userId, fingerprint.value),
      userId === null
        ? Promise.resolve<readonly number[]>([])
        : this.repository.recentLoginHours(userId, this.config.riskScoring.usualHourSampleSize),
    ]);

    const assessment = this.scoring.assess(
      toRiskAssessmentInput({
        fingerprint,
        knownDevice,
        location: toLocation(query.input),
        previousLocation: previous?.location ?? null,
        counters,
        usualHours,
        now,
      }),
    );

    return toRiskAssessmentReadModel(assessment);
  }
}

/** `login_history` has no device name, so the fingerprint's own label is what is shown. */
function toDeviceReadModel(device: DeviceUsage, revoked: boolean): DeviceReadModel {
  return {
    id: device.fingerprint,
    name: device.signals?.platform?.trim() || 'Unknown device',
    platform: device.signals?.platform?.trim() || 'unknown',
    ipAddress: null,
    country: device.location?.country ?? null,
    trusted: device.trusted && !revoked,
    lastSeenAt: device.lastSeenAt.toISOString(),
    loginCount: device.loginCount,
  };
}
