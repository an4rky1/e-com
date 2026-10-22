export type HealthStatus = 'up' | 'down' | 'degraded';

export interface HealthCheckEntry {
  status: HealthStatus;
  /** Why it is degraded rather than down — e.g. a cache miss while the DB is fine. */
  message?: string;
  [detail: string]: unknown;
}

export type HealthCheckResult = Record<string, HealthCheckEntry>;

export interface HealthReport {
  status: HealthStatus;
  uptimeSeconds: number;
  service: string;
  checks: HealthCheckResult;
  timestamp: string;
}