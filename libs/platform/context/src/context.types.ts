/**
 * @fileoverview The context object itself and the structural request/response shapes the
 * service touches.
 *
 * @remarks The request and response interfaces are deliberately minimal rather than Express's
 * `Request`/`Response`: the service reads headers, stamps two fields and subscribes to one
 * event, and typing it against all of Express would make every test double a cast of an
 * object that pretends to have a router, a session and a body parser behind it.
 */

/** The ids minted for this request, plus the space for cross-layer scratch values. */
export interface RequestContext {
  correlationId: string;
  requestId: string;
  timestamps: RequestTimestamps;
  /**
   * Guard-owned scratch space.
   *
   * @remarks Lives here rather than on the Express request so a background job resumed from
   * this context sees the same values the handler saw — the request object is gone by then,
   * the context is not.
   */
  metadata: Record<string, unknown>;
}

export interface RequestTimestamps {
  start: number;
  end?: number;
  durationMs?: number;
}

/** Enough of a request to build a context: headers in, two ids stamped back out. */
export interface ContextRequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  requestId?: string;
}

/** Enough of a response to announce the ids and learn when the request ended. */
export interface ContextResponseLike {
  setHeader(name: string, value: string): void;
  on(event: string, listener: () => void): unknown;
}
