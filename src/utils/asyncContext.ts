import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a callback inside the per-request async context.
 *
 * The request-id middleware initializes this at the HTTP edge so async work
 * kicked off by downstream services can attach the same correlation id to
 * logs, RPC calls, and webhooks.
 */
export const runWithRequestContext = <T>(
  context: RequestContext,
  callback: () => T
): T => requestContextStorage.run(context, callback);

/** Return the active request id for the current async execution chain. */
export const getRequestId = (): string | undefined =>
  requestContextStorage.getStore()?.requestId;

/**
 * Return the active request id, or create a local fallback for work that runs
 * outside an inbound HTTP request such as jobs and isolated unit tests.
 */
export const getOrCreateRequestId = (fallbackFactory: () => string): string =>
  getRequestId() ?? fallbackFactory();
