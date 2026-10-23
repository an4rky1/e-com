/**
 * @fileoverview gRPC transport for account-security.
 *
 * @remarks Four methods, and none of them blocks. `RecordLoginAttempt` and `AssessLoginRisk`
 * both exist to let auth-gateway *choose*; the response carries the lock state and the score
 * as fields precisely so that the refusal, when there is one, is made by the service that has
 * the rest of the request in front of it.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod, GrpcControllerBase } from '@auth/infra/grpc';
import type {
  RecordLoginAttemptRequest,
  RecordLoginAttemptResponse,
  RiskAssessmentResponse,
} from '@auth/contracts';
import type { LoginAttemptInput } from '../../application/commands/login-attempt.commands';
import type { DeviceReadModel } from '../../application/queries/account-security.queries';
// Value import: constructor-injected facade — see the note in credential-vault's gRPC
// controller. A type-only import erases the token Nest needs to resolve it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { AccountSecurityService } from '../../application/facade/account-security.service';

const SERVICE = 'AccountSecurityService';

/**
 * `ListDevicesRequest` / `Response`, `RevokeDeviceRequest` / `Response`.
 *
 * @remarks Spelled out here because `libs/contracts/src/grpc/service-contracts.ts` declares
 * these inline on `AccountSecurityGrpcClient` rather than exporting named interfaces, and
 * `ListDevices` there is typed as `Record<string, unknown>[]` — which would type-check a
 * response this service cannot actually produce. Duplicating the shapes from the proto is
 * cheaper than an anonymous import, and this file stays the one place a drift would show up.
 */
interface ListDevicesRequest {
  userId: string;
}

interface ListDevicesResponse {
  devices: readonly DeviceResponse[];
}

interface DeviceResponse {
  id: string;
  name: string;
  platform: string;
  ipAddress: string;
  country: string;
  trusted: boolean;
  lastSeenAt: string;
}

interface RevokeDeviceRequest {
  userId: string;
  deviceId: string;
}

interface RevokeDeviceResponse {
  ok: boolean;
}

@Controller()
export class AccountSecurityGrpcController extends GrpcControllerBase {
  constructor(private readonly security: AccountSecurityService) {
    // `GrpcControllerBase` exists so `mergeMicroservice` can rely on a controller having no
    // HTTP routes; deriving from it is the whole point, which means the base constructor runs.
    super();
  }

  /**
   * Records one sign-in and reports the resulting lock state.
   *
   * @remarks `locked_until` is epoch millis and 0 when not locked, exactly as the proto declares
   * it. The convention is load-bearing: `new Date(0)` is 1970, so a caller that forgot to
   * special-case it would treat a permanently unlocked account as locked for fifty years.
   *
   * @remarks `failed_attempts` is the count for the *user* and is zero for an attempt that
   * carried no user id — the counter that moved belongs to the ip, and reporting it under this
   * field would tell one caller about another's account.
   */
  @GrpcMethod(SERVICE, 'RecordLoginAttempt')
  async recordLoginAttempt(
    request: RecordLoginAttemptRequest,
  ): Promise<RecordLoginAttemptResponse> {
    const outcome = await this.security.recordLoginAttempt(
      toInput(request),
      request.succeeded === true,
    );

    return {
      locked: outcome.locked,
      failedAttempts: outcome.failedAttempts,
      lockedUntil: outcome.lockedUntil === null ? 0 : outcome.lockedUntil.getTime(),
      securityEventId: outcome.securityEventId,
      retryAfterSeconds: outcome.retryAfterSeconds,
    };
  }

  /**
   * Scores a login that has not happened yet.
   *
   * @remarks Read-only. A caller may pre-flight as often as it likes: nothing here moves a
   * counter, writes a login or raises a signal, so asking twice gives the same answer and asking
   * once gives no trace.
   */
  @GrpcMethod(SERVICE, 'AssessLoginRisk')
  async assessLoginRisk(
    request: Omit<RecordLoginAttemptRequest, 'succeeded'>,
  ): Promise<RiskAssessmentResponse> {
    const assessment = await this.security.assessRisk(toInput(request));

    return {
      score: assessment.score,
      level: assessment.level,
      factors: [...assessment.factors],
      recommendations: [...assessment.recommendations],
    };
  }

  /**
   * The devices an account has signed in from.
   *
   * @remarks Proto3 scalars have no null: an absent country and an empty one are the same
   * message on the wire, so both become `''`. `trusted: false` on a device the user retired is
   * the field that carries that distinction, and it is why the list keeps revoked devices in it.
   */
  @GrpcMethod(SERVICE, 'ListDevices')
  async listDevices(request: ListDevicesRequest): Promise<ListDevicesResponse> {
    const devices = await this.security.listDevices(request.userId);

    return { devices: devices.map(toDeviceResponse) };
  }

  /**
   * Retires a device.
   *
   * @remarks Raises `ResourceNotFoundException` when the fingerprint has never signed this
   * account in. The check is against the durable history rather than a cache, so a revoked
   * device cannot be revoked twice into a second, contradictory signal.
   */
  @GrpcMethod(SERVICE, 'RevokeDevice')
  async revokeDevice(request: RevokeDeviceRequest): Promise<RevokeDeviceResponse> {
    const { ok } = await this.security.revokeDevice({
      userId: request.userId,
      deviceId: request.deviceId,
    });

    return { ok };
  }
}

/**
 * The attempt fields as they arrive, all of them optional.
 *
 * @remarks Declared structurally rather than reusing `RecordLoginAttemptRequest`, because the
 * contract's own fields are camelCase *and* optional while an `AssessLoginRisk` request omits
 * `succeeded` entirely. Reading through this one shape means both methods normalise the same
 * way, and a new proto field cannot reach a handler as `undefined` from one path and `''` from
 * the other.
 */
interface GrpcAttemptFields {
  readonly userId?: string;
  readonly email?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly sessionId?: string;
  readonly deviceFingerprint?: string;
  readonly country?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

/**
 * Flattens the transport shape into the command's own.
 *
 * @remarks Every string becomes `null` when it is empty. `RecordLoginAttemptRequest` carries
 * either a `user_id` or an `email`, and proto3 cannot distinguish an unset string from an empty
 * one — so an absent user id arrives as `''` and must be normalised here rather than passed
 * through as an id that matches no account.
 */
function toInput(request: GrpcAttemptFields): LoginAttemptInput {
  const text = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
  };

  const numeric = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  return {
    userId: text(request.userId),
    email: text(request.email),
    ipAddress: text(request.ipAddress),
    userAgent: text(request.userAgent),
    sessionId: text(request.sessionId),
    deviceFingerprint: text(request.deviceFingerprint),
    country: text(request.country),
    latitude: numeric(request.latitude),
    longitude: numeric(request.longitude),
  };
}

function toDeviceResponse(device: DeviceReadModel): DeviceResponse {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    ipAddress: device.ipAddress ?? '',
    country: device.country ?? '',
    trusted: device.trusted,
    lastSeenAt: device.lastSeenAt,
  };
}