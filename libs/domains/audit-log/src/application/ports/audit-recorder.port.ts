/**
 * @fileoverview How the consumer writes, expressed as a port.
 *
 * @remarks The consumer talks to this rather than to `CommandBus` directly so the seam is
 * named: "record through the CQRS command bus" is a deployment decision (a synchronous bus,
 * a local command bus, a stub in a test), and the thing worth testing — that a failure to
 * store propagates — does not depend on which one is bound.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CommandBus } from '@nestjs/cqrs';
import { Injectable } from '@nestjs/common';
import type { RecordAuditEventInput } from '../commands/record-audit-event.command';
import { toRecordAuditEventCommand } from '../commands/record-audit-event.command';

export const AUDIT_RECORDER = Symbol('AUDIT_RECORDER');

export interface RecordResult {
  readonly id: string;
  readonly appended: boolean;
}

export interface AuditRecorderPort {
  /**
   * Appends one record, or reports that this delivery was already recorded.
   *
   * @remarks Must not swallow a storage failure. The caller's offset decision depends on the
   * distinction between "stored" and "not stored", and an implementation that returns
   * `{ appended: false }` on an error makes an audit gap indistinguishable from a duplicate.
   */
  record(input: RecordAuditEventInput): Promise<RecordResult>;
}

/**
 * Dispatches the command. Deliberately thin: it exists so the port has a real implementation
 * in production and a one-line fake in a test.
 */
@Injectable()
export class CommandBusAuditRecorder implements AuditRecorderPort {
  constructor(private readonly commandBus: CommandBus) {}

  async record(input: RecordAuditEventInput): Promise<RecordResult> {
    return this.commandBus.execute(toRecordAuditEventCommand(input));
  }
}