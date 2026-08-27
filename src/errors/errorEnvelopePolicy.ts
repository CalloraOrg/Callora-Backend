import type { ValidationErrorDetail } from '../middleware/validate.js';

export const PUBLIC_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'PAYMENT_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'REQUEST_TIMEOUT',
  'CONFLICT',
  'REQUEST_BODY_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_ENTITY',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'VALIDATION_ERROR',
  'INVALID_BODY',
  'INVALID_QUERY',
  'INVALID_PARAMS',
  'INVALID_VALUE',
  'INSUFFICIENT_BALANCE',
  'NETWORK_UNAVAILABLE',
  'NETWORK_MISMATCH',
  'SOROBAN_RPC_TIMEOUT',
  'SOROBAN_RPC_ERROR',
  'BILLING_DEDUCTION_FAILED',
  'BILLING_REQUEST_NOT_FOUND',
  'DEVELOPER_NOT_FOUND',
  'API_ACCESS_FORBIDDEN',
  'API_KEY_NOT_FOUND',
  'API_KEY_FORBIDDEN',
  'NOT_AUTHENTICATED',
  'REFRESH_FAILED',
  'REVOKE_FAILED',
  'VAULT_NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type PublicErrorCode = typeof PUBLIC_ERROR_CODES[number];

const codeByStatus: Record<number, PublicErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  413: 'REQUEST_BODY_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

const sensitiveMessage = /(?:password|secret|token|authorization|stack|postgres|sql|database url|connection string)/i;

export function isPublicErrorCode(value: unknown): value is PublicErrorCode {
  return typeof value === 'string' && (PUBLIC_ERROR_CODES as readonly string[]).includes(value);
}

export function publicCodeForStatus(status: number): PublicErrorCode {
  return codeByStatus[status] ?? (status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST');
}

export function normalizePublicCode(value: unknown, status: number): PublicErrorCode {
  return isPublicErrorCode(value) ? value : publicCodeForStatus(status);
}

export function safePublicMessage(message: unknown, status: number, isTrustedError: boolean, isDevelopment = false): string {
  if (status === 413) return 'Request body too large';
  if (isTrustedError && typeof message === 'string' && message.trim() !== '') return message;
  if (isDevelopment && status < 500 && typeof message === 'string' && message.trim() !== '' && !sensitiveMessage.test(message)) return message;
  return status >= 500 ? 'Internal server error' : 'Request failed';
}

export function safeValidationDetails(value: unknown): ValidationErrorDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const details = value.filter((item): item is ValidationErrorDetail => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate.field === 'string' && typeof candidate.message === 'string' && typeof candidate.code === 'string';
  }).map((detail) => ({
    field: detail.field.slice(0, 200),
    message: detail.message.slice(0, 500),
    code: detail.code.slice(0, 100),
  }));
  return details.length > 0 ? details : undefined;
}

export function boundedRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.floor(value), 86_400_000);
}

export interface NormalizedError {
  statusCode: number;
  code: PublicErrorCode;
  message: string;
  details?: ValidationErrorDetail[];
  retryAfterMs?: number;
}

export function normalizeError(input: {
  statusCode: number;
  code?: unknown;
  message?: unknown;
  details?: unknown;
  retryAfterMs?: unknown;
  trusted: boolean;
  development?: boolean;
}): NormalizedError {
  const normalized: NormalizedError = {
    statusCode: input.statusCode,
    code: normalizePublicCode(input.code, input.statusCode),
    message: safePublicMessage(input.message, input.statusCode, input.trusted, input.development ?? false),
  };
  const details = safeValidationDetails(input.details);
  const retryAfterMs = boundedRetryAfterMs(input.retryAfterMs);
  if (details) normalized.details = details;
  if (retryAfterMs !== undefined) normalized.retryAfterMs = retryAfterMs;
  return normalized;
}
