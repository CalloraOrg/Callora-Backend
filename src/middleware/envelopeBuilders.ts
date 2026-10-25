import type { RedactedSimulationDetailsSummary } from '../errors/errorEnvelopePolicy.js';
import { safeSimulationDetails } from '../errors/errorEnvelopePolicy.js';
import type { ErrorDetails } from '../types/ResponseEnvelope.js';


import { type EnvelopeMeta, type ErrorEnvelope, type SuccessEnvelope } from "./envelopeSchemas.js";
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

export function shouldSkipContentType(contentType: unknown): boolean {
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
  details?: ErrorDetails,
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
  if (details !== undefined && (!Array.isArray(details) || details.length > 0)) {
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
