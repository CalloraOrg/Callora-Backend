import { NextFunction, Request, Response } from 'express';
import type { RedactedSimulationDetailsSummary } from '../errors/errorEnvelopePolicy.js';
import { safeSimulationDetails } from '../errors/errorEnvelopePolicy.js';
import type { ValidationErrorDetail } from './validate.js';
import type { ErrorDetails } from '../types/ResponseEnvelope.js';


import { buildErrorEnvelope, buildSuccessEnvelope, shouldSkipContentType } from "./envelopeBuilders.js";
import { featureErrorDetailsSchema, type EnvelopeMeta } from "./envelopeSchemas.js";

export { buildErrorEnvelope, buildSuccessEnvelope } from "./envelopeBuilders.js";
export * from "./envelopeSchemas.js";
export { createResponseValidatorMiddleware } from "./responseValidator.js";

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
      let details: ErrorDetails | undefined;
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
        } else {
          const feature = featureErrorDetailsSchema.safeParse(bodyObj.details);
          if (feature.success) details = feature.data;
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
