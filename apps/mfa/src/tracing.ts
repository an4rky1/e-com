/**
 * @fileoverview Starts the trace SDK before this process's composition root loads.
 *
 * @remarks One line by design: the ordering between this import and `.app.module` is the
 * feature, so the file exists to keep the call out of `main.ts`'s own logic. See
 * `startTracing` for the instrumentation list and the `OTEL_*` surface.
 */
import { startTracing } from '@auth/platform/observability';

startTracing('mfa');
