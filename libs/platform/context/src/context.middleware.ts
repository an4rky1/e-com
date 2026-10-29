/**
 * @fileoverview Opens the request context around the whole request.
 *
 * @remarks Registered as Express middleware (through `NestModule.configure`) rather than as a
 * guard or interceptor because it must run before auth: everything that logs during the
 * request — a 401 among them — needs the id, and a context opened after the guards would be
 * missing exactly the requests that failed.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextService } from './context.service';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // Wrapping `next` is the whole mechanism: `AsyncLocalStorage.run` keeps the context
    // active for everything scheduled inside this callback, which is every layer below.
    this.context.runWithRequest(req, res, () => next());
  }
}
