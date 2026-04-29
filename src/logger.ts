import { AsyncLocalStorage } from 'node:async_hooks';

type RequestContext = { requestId: string };

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const REDACTED_LOG_VALUE = '[REDACTED]';

const SENSITIVE_LOG_KEYS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'xapikey',
  'xauthtoken',
  'xadminapikey',
  'proxyauthorization',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'webhooksecret',
  'apikey',
  'apikeyhash',
  'keyhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'jwt',
]);

export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'req.headers["x-admin-api-key"]',
  'req.headers["proxy-authorization"]',
];

export const runWithRequestContext = <T>(context: RequestContext, callback: () => T): T =>
  requestContextStorage.run(context, callback);

export const getRequestId = (): string | undefined => requestContextStorage.getStore()?.requestId;

const normalizeLogKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

const isSensitiveLogKey = (key: string): boolean => SENSITIVE_LOG_KEYS.has(normalizeLogKey(key));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const redactLogValueInternal = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValueInternal(entry, seen));
  }

  if (value instanceof Error) {
    const redactedError: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };

    if (value.stack) {
      redactedError.stack = value.stack;
    }

    for (const key of Object.keys(value)) {
      const errorRecord = value as unknown as Record<string, unknown>;
      redactedError[key] = isSensitiveLogKey(key)
        ? REDACTED_LOG_VALUE
        : redactLogValueInternal(errorRecord[key], seen);
    }

    return redactedError;
  }

  if (isPlainObject(value)) {
    const redactedObject: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      redactedObject[key] = isSensitiveLogKey(key)
        ? REDACTED_LOG_VALUE
        : redactLogValueInternal(entry, seen);
    }

    return redactedObject;
  }

  return value;
};

export const redactLogValue = (value: unknown): unknown =>
  redactLogValueInternal(value, new WeakSet<object>());

export const redactLogArguments = (args: unknown[]): unknown[] =>
  args.map((arg) => redactLogValue(arg));

const formatArgs = (args: unknown[]): unknown[] => {
  const requestId = getRequestId();
  const redactedArgs = redactLogArguments(args);
  return requestId ? [`[request_id:${requestId}]`, ...redactedArgs] : redactedArgs;
};

const wrapLog = (fn: (...args: unknown[]) => void) => (...args: unknown[]) => {
  fn(...formatArgs(args));
};

export const logger = {
  info: wrapLog(console.log),
  warn: wrapLog(console.warn),
  error: wrapLog(console.error),
  audit: (event: string, actor: string, details?: Record<string, unknown>) => {
    const logData = {
      type: 'AUDIT',
      event,
      actor,
      timestamp: new Date().toISOString(),
      ...(details ? { details: redactLogValue(details) } : {}),
    };
    // Use console.log directly via wrapLog to ensure consistent formatting
    const auditLogger = wrapLog(console.log);
    auditLogger(logData);
  },
};
