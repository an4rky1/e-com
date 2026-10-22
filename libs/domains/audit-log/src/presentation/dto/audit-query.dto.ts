/**
 * @fileoverview The HTTP shape of an audit record.
 *
 * @remarks The query DTO exists so the controller does not hand the query layer whatever
 * arrived in the URL. That matters more here than in most services: every field on this
 * endpoint becomes a `WHERE` clause, and an unparsed `from=not-a-date` that reaches Prisma is
 * an unhandled 500 rather than a 400 telling the operator they typed it wrong.
 */
import { AuditResult, ResourceType, isAuditResult } from '../../domain/value-objects/audit-result.vo';
import type { AuditFilter } from '../../domain/ports/audit-repository.port';

export interface AuditQueryDto {
  actorId?: string;
  actorType?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  result?: string;
  /** ISO-8601, inclusive. */
  from?: string;
  /** ISO-8601, exclusive. */
  to?: string;
  page?: string;
  limit?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** One place that turns a possibly-bad string into a `Date`, so the rule is stated once. */
function parseDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;

  const trimmed = value.trim();
  if (!ISO.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new TypeError(`"${field}" must be an ISO-8601 timestamp; received "${value}"`);
  }

  return new Date(trimmed);
}

/** A bounded, positive integer. `?page=0` and `?page=-1` are as wrong as `?page=abc`. */
function parsePositiveInt(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`"${field}" must be a positive integer; received "${value}"`);
  }

  return parsed;
}

/**
 * Builds the repository filter, validating the two vocabularies the domain owns.
 *
 * @remarks An unknown `result` is refused rather than passed through. `result=sucess` silently
 * returning an empty list is the worst answer this endpoint can give: it reads as "nothing
 * happened", which for an audit log is indistinguishable from "the log is lying".
 */
export function toAuditFilter(dto: AuditQueryDto): AuditFilter {
  if (dto.result !== undefined && !isAuditResult(dto.result)) {
    throw new TypeError(
      `"result" must be one of ${Object.values(AuditResult).join(', ')}; received "${dto.result}"`,
    );
  }

  if (dto.resourceType !== undefined && !isResourceType(dto.resourceType)) {
    throw new TypeError(
      `"resourceType" must be one of ${Object.values(ResourceType).join(', ')}; received "${
        dto.resourceType
      }"`,
    );
  }

  return {
    ...(dto.actorId === undefined ? {} : { actorId: dto.actorId.trim() }),
    ...(dto.actorType === undefined ? {} : { actorType: dto.actorType.trim() }),
    ...(dto.action === undefined ? {} : { action: dto.action.trim() }),
    ...(dto.resourceType === undefined ? {} : { resourceType: dto.resourceType.trim() }),
    ...(dto.resourceId === undefined ? {} : { resourceId: dto.resourceId.trim() }),
    ...(dto.result === undefined ? {} : { result: dto.result }),
    ...(parseDate(dto.from, 'from') === undefined
      ? {}
      : { from: parseDate(dto.from, 'from') as Date }),
    ...(parseDate(dto.to, 'to') === undefined ? {} : { to: parseDate(dto.to, 'to') as Date }),
  };
}

export function toPageNumbers(
  dto: AuditQueryDto,
): { page?: number; limit?: number } {
  const page = parsePositiveInt(dto.page, 'page');
  const limit = parsePositiveInt(dto.limit, 'limit');
  return {
    ...(page === undefined ? {} : { page }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function isResourceType(value: string): value is ResourceType {
  return (Object.values(ResourceType) as string[]).includes(value);
}