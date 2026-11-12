'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, viaProxy } from '@auth/contracts/http';
import type { ApiErrorResponse, ApiMethod } from '@auth/contracts/http';
import { authHeaders } from './session';

/**
 * A contract route as the client needs it: method, browser path, guard.
 *
 * @remarks Wider than the `as const` maps on purpose — a parameterised path is filled in
 * at the call site (`/orders/:id` → `/orders/42`), which cannot stay inside the literal
 * union of the contract object.
 */
export interface StorefrontRouteLike {
  readonly method: ApiMethod;
  readonly path: string;
  readonly authenticated: boolean;
}

/**
 * One storefront call through the front's proxy.
 *
 * @remarks Returns the parsed body on `response.ok`, otherwise throws the gateway's
 * refusal message. The token comes from the session helper — never from props — so a
 * page cannot accidentally render a bearer it was handed.
 */
export async function storefrontFetch<T>(
  route: StorefrontRouteLike,
  init: RequestInit = {},
): Promise<T> {
  const headers = authHeaders();
  if (!headers && route.authenticated) {
    throw new Error('Sign in to continue');
  }

  const response = await fetch(viaProxy(route as Parameters<typeof viaProxy>[0]), {
    ...init,
    method: route.method,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
      ...init.headers,
    },
  });

  const payload = (await response.json().catch(() => ({}))) as T | ApiErrorResponse;
  if (!response.ok) {
    throw new Error(
      apiErrorMessage(payload as ApiErrorResponse, `Request failed (${response.status})`),
    );
  }
  return payload as T;
}

/** Load a storefront route once, with a manual reload. Public and authed routes alike. */
export function useStorefront<T>(route: StorefrontRouteLike): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    storefrontFetch<T>(route)
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setData(null);
          setError(err instanceof Error ? err.message : 'The gateway did not answer');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [route, tick]);

  return { data, error, loading, reload };
}
