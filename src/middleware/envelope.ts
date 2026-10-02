import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema, ZodError } from 'zod';
import type { ValidationErrorDetail } from './validate.js';
import { InternalServerError } from '../errors/index.js';
import { safeSimulationDetails } from '../errors/errorEnvelopePolicy.js';
import type { RedactedSimulationDetailsSummary } from '../errors/errorEnvelopePolicy.js';
import { logger } from '../logger.js';

const SKIP_CONTENT_TYPES = [
  'text/csv',
  'application/octet-stream',
  'application/pdf',
  'text/event-stream',
  'text/plain',
  'multipart/form-data',
  'application/zip',
  'application/gzip',
  'image/',
  'audio/',
  'video/',
];

export const successEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
  meta: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string(),
  timestamp: z.string().datetime(),
});

/**
 * Optional, additive member of `error` describing a failed Soroban
 * simulation. Only the redacted summary fields are representable here, so a
 * client can rely on `error.simulationDetails` never containing addresses,
 * balances, XDR or signatures.
 */
export const simulationDetailsSchema = z.object({
  errorCode: z.union([z.string(), z.number()]).optional(),
  errorMessage: z.string().optional(),
  eventCount: z.number().optional(),
  footprintPresent: z.boolean().optional(),
});

export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({
      field: z.string(),
      message: z.string(),
      code: z.string(),
    })).optional(),
    retryAfterMs: z.number().optional(),
    simulationDetails: simulationDetailsSchema.optional(),
  }),
  requestId: z.string(),
  timestamp: z.string().datetime(),
});

export const envelopeSchema = z.union([successEnvelopeSchema, errorEnvelopeSchema]);

export type SuccessEnvelope<T = unknown> = z.infer<typeof successEnvelopeSchema> & { data: T };
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

export interface EnvelopeMeta {
  [key: string]: unknown;
}

function shouldSkipContentType(contentType: unknown): boolean {
  if (!contentType || typeof contentType !== 'string') {
    return false;
  }
  const lower = contentType.toLowerCase();
  return SKIP_CONTENT_TYPES.some((t) => lower.includes(t));
}

export function buildSuccessEnvelope<T>(
  data: T,
  requestId: string,
  meta?: EnvelopeMeta,
): SuccessEnvelope<T> {
  const envelope: SuccessEnvelope<T> = {
    success: true,
    data,
    requestId,
    timestamp: new Date().toISOString(),
  };
  if (meta && Object.keys(meta).length > 0) {
    envelope.meta = meta;
  }
  return envelope;
}

export function buildErrorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: ValidationErrorDetail[],
  retryAfterMs?: number,
  simulationDetails?: RedactedSimulationDetailsSummary,
): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    success: false,
    error: {
      code,
      message,
    },
    requestId,
    timestamp: new Date().toISOString(),
  };
  if (details && details.length > 0) {
    envelope.error.details = details;
  }
  if (retryAfterMs !== undefined) {
    envelope.error.retryAfterMs = retryAfterMs;
  }
  const safeDetails = safeSimulationDetails(simulationDetails);
  if (safeDetails) {
    envelope.error.simulationDetails = safeDetails;
  }
  return envelope;
}

export function envelopeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const requestId = req.id || 'unknown';

  function wrapBody(body: unknown): unknown {
    if (res.headersSent) {
      return body;
    }

    const contentType = res.getHeader('Content-Type');
    if (shouldSkipContentType(contentType)) {
      return body;
    }

    if (
      body !== null &&
      typeof body === 'object' &&
      'success' in body &&
      typeof (body as { success?: unknown }).success === 'boolean' &&
      'requestId' in body &&
      'timestamp' in body
    ) {
      return body;
    }

    const statusCode = res.statusCode;

    if (statusCode >= 400) {
      let code = 'BAD_REQUEST';
      let message = 'Request failed';
      let details: ValidationErrorDetail[] | undefined;
      let retryAfterMs: number | undefined;
      let simulationDetails: RedactedSimulationDetailsSummary | undefined;

      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const bodyObj = body as Record<string, unknown>;
        if (typeof bodyObj.code === 'string') {
          code = bodyObj.code;
        } else if (statusCode >= 500) {
          code = 'INTERNAL_SERVER_ERROR';
        }
        if (typeof bodyObj.message === 'string') {
          message = bodyObj.message;
        } else if (typeof bodyObj.error === 'string') {
          message = bodyObj.error;
        }
        if (Array.isArray(bodyObj.details)) {
          details = bodyObj.details as ValidationErrorDetail[];
        }
        if (typeof bodyObj.retryAfterMs === 'number') {
          retryAfterMs = bodyObj.retryAfterMs;
        }
        // Preserve a redacted simulation summary when a route (or an upstream
        // proxy) emits the canonical SIMULATION_FAILED shape directly. The
        // whitelist keeps raw diagnostics out of the envelope.
        if (bodyObj.simulationDetails !== undefined) {
          simulationDetails = safeSimulationDetails(bodyObj.simulationDetails);
        }
      }

      return buildErrorEnvelope(code, message, requestId, details, retryAfterMs, simulationDetails);
    }

    let data = body;
    let meta: EnvelopeMeta | undefined;

    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const bodyObj = body as Record<string, unknown>;
      if ('data' in bodyObj && 'meta' in bodyObj && Object.keys(bodyObj).length === 2) {
        data = bodyObj.data;
        meta = bodyObj.meta as EnvelopeMeta;
      }
    }

    return buildSuccessEnvelope(data, requestId, meta);
  }

  res.json = function jsonWrapper(body: unknown): Response {
    return originalJson(wrapBody(body));
  };

  res.send = function sendWrapper(body: unknown): Response {
    if (res.headersSent) {
      return originalSend(body);
    }

    const contentType = res.getHeader('Content-Type');
    if (shouldSkipContentType(contentType)) {
      return originalSend(body);
    }

    let parsed: unknown = body;
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (trimmed.length > 0 && (trimmed[0] === '{' || trimmed[0] === '[')) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return originalSend(body);
        }
      } else {
        return originalSend(body);
      }
    }

    if (parsed !== null && typeof parsed === 'object') {
      const wrapped = wrapBody(parsed);
      if (typeof body === 'string') {
        return originalSend(JSON.stringify(wrapped));
      }
      return originalJson(wrapped as Record<string, unknown>);
    }

    return originalSend(body);
  };

  next();
}

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
