/**
 * Canonical response envelope for all Callora API endpoints.
 * Every response — success or error — must conform to this shape.
 * This ensures consistent client parsing and contract stability.
 */

export interface SuccessEnvelope<T = unknown> {
  success: true;
  data: T;
  meta?: ResponseMeta;
  requestId: string;
  timestamp: string; // ISO 8601
}

/**
 * Redacted Soroban simulation diagnostics attached to a `SIMULATION_FAILED`
 * error. Only these four fields are ever published; raw simulation payloads
 * (addresses, balances, XDR, signatures) are redacted before reaching here.
 */
export interface SimulationDetailsSummary {
  errorCode?: string | number;
  errorMessage?: string;
  eventCount?: number;
  footprintPresent?: boolean;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    /** Present only for simulation failures; additive and optional. */
    simulationDetails?: SimulationDetailsSummary;
  };
  requestId: string;
  timestamp: string;
}

export interface ResponseMeta {
  page?: number;
  perPage?: number;
  total?: number;
  [key: string]: unknown;
}

export type ApiEnvelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

/** Schema for validating envelope shape at runtime */
export const ENVELOPE_REQUIRED_FIELDS = ['success', 'requestId', 'timestamp'] as const;
export const SUCCESS_REQUIRED_FIELDS = ['data'] as const;
export const ERROR_REQUIRED_FIELDS = ['error'] as const;
