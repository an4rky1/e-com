/**
 * @fileoverview The scrape endpoint: Prometheus pulls `GET /metrics` from this process.
 *
 * @remarks Manual `@Res` rather than a returned value: the body is the registry's serialised
 * form and the content type is the registry's own (`text/plain; version=0.0.4`), and Nest
 * overriding either would be a second, disagreeing answer to what the scrape format is.
 */
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { OBSERVABILITY_METRICS, type AppMetrics } from './metrics.registry';

@Controller()
export class MetricsController {
  constructor(
    @Inject(OBSERVABILITY_METRICS) private readonly metrics: AppMetrics,
  ) {}

  @Get('metrics')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
