import { NextFunction, Request, Response } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { InternalServerError } from '../errors/index.js';
import { logger } from '../logger.js';


import { buildErrorEnvelope, shouldSkipContentType } from "./envelopeBuilders.js";
import { envelopeSchema, type Envelope } from "./envelopeSchemas.js";
export function createResponseValidatorMiddleware(schema?: ZodSchema) {
  return function responseValidatorMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);
    const requestId = req.id || 'unknown';

    function validateAndSend(body: unknown): Response {
      if (res.headersSent) {
        return originalSend(body as string);
      }

      const contentType = res.getHeader('Content-Type');
      if (shouldSkipContentType(contentType)) {
        return originalSend(body as string);
      }

      let parsedBody = body;
      if (typeof body === 'string') {
        const trimmed = body.trim();
        if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
          return originalSend(body as string);
        }
        try {
          parsedBody = JSON.parse(trimmed);
        } catch {
          return originalSend(body as string);
        }
      }

      if (parsedBody === undefined || parsedBody === null) {
        return originalSend(body as string);
      }

      try {
        envelopeSchema.parse(parsedBody);
      } catch (err) {
        if (err instanceof ZodError) {
          logger.error('[responseValidator] Response failed envelope validation', {
            requestId,
            path: req.path,
            issues: err.issues,
          });

          if (!res.headersSent) {
            const devError = new InternalServerError(
              'Response contract violation: envelope validation failed',
              'INTERNAL_SERVER_ERROR',
            );
            const errorEnvelope = buildErrorEnvelope(
              devError.code ?? 'INTERNAL_SERVER_ERROR',
              devError.message,
              requestId,
            );
            res.status(500);
            return originalJson(errorEnvelope);
          }
        }
        throw err;
      }

      if (schema) {
        try {
          const env = parsedBody as Envelope;
          if (env.success) {
            schema.parse(env.data);
          }
        } catch (err) {
          if (err instanceof ZodError) {
            logger.error('[responseValidator] Response failed data schema validation', {
              requestId,
              path: req.path,
              issues: err.issues,
            });
            if (!res.headersSent) {
              const devError = new InternalServerError(
                'Response contract violation: data schema validation failed',
                'INTERNAL_SERVER_ERROR',
              );
              const errorEnvelope = buildErrorEnvelope(
                devError.code ?? 'INTERNAL_SERVER_ERROR',
                devError.message,
                requestId,
              );
              res.status(500);
              return originalJson(errorEnvelope);
            }
          }
          throw err;
        }
      }

      if (typeof body === 'string') {
        return originalSend(body);
      }
      return originalJson(parsedBody as Record<string, unknown>);
    }

    res.send = function sendWrapper(body: unknown): Response {
      return validateAndSend(body);
    };

    res.json = function jsonWrapper(body: unknown): Response {
      return validateAndSend(body);
    };

    next();
  };
}
