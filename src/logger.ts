import { AsyncLocalStorage } from 'node:async_hooks';

type RequestContext = { requestId: string };

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, callback: () => T): T =>
  requestContextStorage.run(context, callback);

export const getRequestId = (): string | undefined => requestContextStorage.getStore()?.requestId;

const formatArgs = (args: unknown[]): unknown[] => {
  const requestId = getRequestId();
  return requestId ? [`[request_id:${requestId}]`, ...args] : args;
};

const wrapLog = (fn: (...args: unknown[]) => void) => (...args: unknown[]) => {
  fn(...formatArgs(args));
};

export const logger = {
  info: wrapLog(console.log),
  warn: wrapLog(console.warn),
  error: wrapLog(console.error),
};
