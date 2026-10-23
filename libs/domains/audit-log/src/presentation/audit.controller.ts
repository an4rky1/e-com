/**
 * @fileoverview HTTP transport for audit-log.
 *
 * @remarks Read-only by construction. There is no `POST`, no `PUT` and no `DELETE` on this
 * controller, and that is the point: an audit log that accepts an edit over HTTP is not
 * append-only, and the hash chain is the only thing standing between an operator with a
 * database client and a history that says something else happened.
 *
 * @remarks Talks only to {@link AuditLogService}. It holds no business rule of its own — the
 * only decision made here is turning a malformed query parameter into a 400, which is a
 * transport concern rather than a domain one.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Query,
} from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { AuditLogService } from '../application/facade/audit-log.service';
import { toAuditFilter, toPageNumbers, type AuditQueryDto } from './dto/audit-query.dto';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  async search(@Query() query: AuditQueryDto) {
    try {
      const { page, limit } = toPageNumbers(query);
      return this.audit.search(toAuditFilter(query), page, limit);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Recomputes one partition's chain, or every partition when `partitionKey` is absent.
   *
   * @remarks Declared before any `:param` route it is not: a `verify` segment routed as an id
   * would return "no such record" for the one request an operator makes when they suspect
   * tampering. There is no `:param` route here today, and the order is the reason there does
   * not need to be one.
   */
  @Get('verify')
  async verify(@Query('partitionKey') partitionKey?: string) {
    return this.audit.verify(partitionKey);
  }
}