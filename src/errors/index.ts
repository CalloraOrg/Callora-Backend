/**
 * Custom error classes for consistent HTTP error handling.
 * Use these in routes/services; the global error handler maps them to status codes and JSON.
 */

import type { ErrorCode as ErrorCodeType } from "./codes.js";

// Re-export ErrorCode from the generated codes module
export { ErrorCode, isErrorCode, type ErrorCode as ErrorCodeType } from "./codes.js";

export class AppError extends Error {
  public readonly isAppError = true;

  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code?: ErrorCodeType,
  ) {
    super(message);
    this.name = "AppError";
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = "Bad request", code?: ErrorCodeType) {
    super(message, 400, code ?? "BAD_REQUEST");
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized", code?: ErrorCodeType) {
    super(message, 401, code ?? "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Forbidden", code?: ErrorCodeType) {
    super(message, 403, code ?? "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Not found", code?: ErrorCodeType) {
    super(message, 404, code ?? "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class PaymentRequiredError extends AppError {
  constructor(message: string = "Payment Required", code?: ErrorCodeType) {
    super(message, 402, code ?? "PAYMENT_REQUIRED");
    this.name = "PaymentRequiredError";
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string = "Too Many Requests", code?: ErrorCodeType) {
    super(message, 429, code ?? "TOO_MANY_REQUESTS");
    this.name = "TooManyRequestsError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string = "Conflict", code?: ErrorCodeType) {
    super(message, 409, code ?? "CONFLICT");
    this.name = "ConflictError";
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = "Internal server error", code?: ErrorCodeType) {
    super(message, 500, code ?? "INTERNAL_SERVER_ERROR");
    this.name = "InternalServerError";
  }
}

export class BadGatewayError extends AppError {
  constructor(
    message: string = "Bad Gateway",
    code?: ErrorCodeType,
    public readonly simulationDetails?: unknown,
  ) {
    super(message, 502, code ?? "BAD_GATEWAY");
    this.name = "BadGatewayError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string = "Service unavailable", code?: ErrorCodeType) {
    super(message, 503, code ?? "SERVICE_UNAVAILABLE");
    this.name = "ServiceUnavailableError";
  }
}

export class GatewayTimeoutError extends AppError {
  constructor(message: string = "Gateway Timeout", code?: ErrorCodeType) {
    super(message, 504, code ?? "GATEWAY_TIMEOUT");
    this.name = "GatewayTimeoutError";
  }
}

export function isAppError(err: unknown): err is AppError {
  return (
    !!err &&
    typeof err === "object" &&
    (err as Record<string, unknown>).isAppError === true
  );
}
