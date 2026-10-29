/**
 * @fileoverview Records one observation per HTTP request into the latency histogram.
 *
 * @remarks Middleware rather than an interceptor for the same reason `RequestContextMiddleware`
 * is: an interceptor never sees the requests an interceptor's own layer rejects — a 404 and a
 * guard-denied request are exactly the traffic a service-level latency panel must include.
 *
 * @remarks The `route` label is the Express route *template* (`/users/:id`), never the concrete
 * path: a label with an id in it is one series per row in the database, and the scrape becomes
 * the outage. Requests that match no route share one `__unmatched__` series.
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  OBSERVABILITY_METRICS,
  type AppMetrics,
} from './metrics.registry';

/** One shared bucket for every request the router did not match. */
const UNMATCHED_ROUTE = '__unmatched__';

/**
 * The matched route's template, or the sentinel.
 *
 * @remarks `req.route` only exists once routing has run, which is why the observation happens
 * on response finish rather than when this middleware executes.
 */
function routeTemplateOf(req: Request): string {
  const route = (req as { route?: { path?: unknown } }).route;
  if (route === undefined || typeof route.path !== 'string') {
    return UNMATCHED_ROUTE;
  }
  return `${req.baseUrl ?? ''}${route.path}`;
}

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(
    @Inject(OBSERVABILITY_METRICS) private readonly metrics: AppMetrics,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    let recorded = false;

    const record = (): void => {
      // `close` follows `finish` on a completed response and replaces it on an aborted one;
      // the flag keeps the two events to a single observation either way.
      if (recorded) {
        return;
      }
      recorded = true;
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.httpRequestDurationSeconds.observe(
        {
          method: req.method,
          route: routeTemplateOf(req),
          status_code: String(res.statusCode),
        },
        seconds,
      );
    };

    res.on('finish', record);
    res.on('close', record);
    next();
  }
}
