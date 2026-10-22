import { HttpException, type HttpExceptionOptions } from '@nestjs/common';
import {
  resolveErrorDefinition,
  type ErrorCategory,
  type ErrorSeverity,
} from './error-codes';

/**
 * Fields whose values must never reach a log sink or an HTTP body.
 *
 * @remarks Redaction is applied by key name, on a deny-list, because auth is where
 * plaintext secrets actually live. The list is deliberately broad: a false positive costs
 * a debuggable value, a false negative puts a live password in a log aggregator.
 */
export const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'new_password',
  'current_password',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'backupcode',
  'backup_code',
  'totp',
  'totpsecret',
  'otp',
  'cookie',
  'setcookie',
  'authorization',
  'auth',
  'sessionid',
  'session_id',
  'privatekey',
  'private_key',
  'secretkey',
  'secret_key',
  'pepper',
  'cvv',
  'ssn',
  'creditcard',
  'credit_card',
  'cardnumber',
  'card_number',
]);

const MAX_MESSAGE_LENGTH = 1000;

export interface AppExceptionOptions {
  /** Machine-readable code; unknown codes collapse to `INTERNAL_ERROR` deliberately. */
  code: string;
  message?: string;
  cause?: unknown;
  /** Structured detail. Redacted before it is ever serialised. */
  context?: Record<string, unknown>;
  /** Overrides the registry status — used when a domain code needs a different surface. */
  status?: number;
  retryable?: boolean;
}

/**
 * Base class for every error this platform throws on purpose.
 *
 * Why it extends `HttpException`: Nest already renders `HttpException` correctly even when
 * no filter is registered, and built-in guards/interceptors depend on the status. Keeping
 * that behaviour means a missing filter degrades to a sane response rather than a stack
 * trace in the body.
 */
export class AppException extends HttpException {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;
  override readonly cause: unknown;
  readonly timestamp: Date;

  constructor(options: AppExceptionOptions, description?: string) {
    const definition = resolveErrorDefinition(options.code);
    const message = (options.message ?? definition.defaultMessage).slice(
      0,
      MAX_MESSAGE_LENGTH,
    );
    const safeContext = redact(options.context ?? {}) as Record<string, unknown>;

    super(
      { code: definition.code, message, ...safeContext },
      options.status ?? definition.status,
      { cause: options.cause, description } satisfies HttpExceptionOptions,
    );

    this.code = definition.code;
    this.category = definition.category;
    this.severity = definition.severity;
    this.retryable = options.retryable ?? definition.retryable;
    this.context = safeContext;
    this.cause = options.cause;
    this.timestamp = new Date();
  }
}

/** Recursively replaces sensitive values. Cycles collapse to `[Circular]`. */
export function redact(
  input: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (input === null || typeof input !== 'object') return input;

  if (seen.has(input as object)) return '[Circular]';
  seen.add(input as object);

  if (Array.isArray(input)) return input.map((item) => redact(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    output[key] = SENSITIVE_FIELDS.has(key.toLowerCase())
      ? '[REDACTED]'
      : redact(value, seen);
  }
  return output;
}