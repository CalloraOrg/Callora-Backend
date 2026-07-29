import pino from 'pino';
import { PINO_REDACT_PATHS, REDACTED_LOG_VALUE, redactLogArguments } from '../logger.js';
import { getRequestId } from '../utils/asyncContext.js';

const isProduction = process.env.NODE_ENV === 'production';
const defaultLevel = isProduction ? 'info' : 'debug';
const level = (process.env.LOG_LEVEL ?? defaultLevel).toLowerCase();

export const structuredLoggerOptions: Parameters<typeof pino>[0] = {
  level,
  redact: {
    paths: PINO_REDACT_PATHS,
    censor: REDACTED_LOG_VALUE,
  },
  hooks: {
    logMethod(args, method) {
      const activeRequestId = getRequestId();

      if (args.length === 0) {
        if (activeRequestId) {
          return method.apply(this, [{ requestId: activeRequestId }]);
        }
        return method.apply(this, args as [obj: unknown, msg?: string | undefined, ...args: unknown[]]);
      }

      const redactedArgs = redactLogArguments(args);
      if (!activeRequestId) {
        return method.apply(
          this,
          redactedArgs as [obj: unknown, msg?: string | undefined, ...args: unknown[]],
        );
      }

      const [first, ...rest] = redactedArgs;
      if (
        first &&
        typeof first === 'object' &&
        !Array.isArray(first) &&
        !(first instanceof Error)
      ) {
        return method.apply(this, [
          { ...(first as Record<string, unknown>), requestId: activeRequestId },
          ...rest,
        ] as [obj: unknown, msg?: string | undefined, ...args: unknown[]]);
      }

      return method.apply(this, [
        { requestId: activeRequestId },
        ...redactedArgs,
      ] as [obj: unknown, msg?: string | undefined, ...args: unknown[]]);
    },
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }),
};

export const logger = pino(structuredLoggerOptions);
