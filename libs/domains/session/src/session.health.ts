import { HealthIndicator } from '@auth/platform/health';
import {
  ActiveSessions,
  type SessionRepositoryPort,
} from './domain/ports/session-repository.port';

/**
 * Reports whether session can serve reads.
 *
 * @remarks Probes the repository rather than the database socket: "can I list live sessions"
 * is the question a readiness check actually cares about, and it exercises the same path the
 * gateway depends on.
 */
export class SessionHealthIndicator extends HealthIndicator {
  constructor(private readonly sessions: SessionRepositoryPort) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();
    try {
      const active = await this.sessions.count(new ActiveSessions());
      return this.withStatus('session', true, {
        latencyMs: Date.now() - started,
        activeSessions: active,
      });
    } catch (error) {
      return this.withStatus('session', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}