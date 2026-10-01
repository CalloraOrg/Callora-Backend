/**
 * Custom error classes for consistent HTTP error handling.
 * Use these in routes/services; the global error handler maps them to status codes and JSON.
 */

import type { ErrorCode as ErrorCodeType } from "./codes.js";
import { redactSimulationDetails } from "../lib/simulationDiagnostics.js";

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

/**
 * A Soroban simulation (pre-flight) returned a failure response.
 *
 * This is a `BadGatewayError` (502) carrying the canonical
 * `SIMULATION_FAILED` code plus a *redacted* summary of the RPC diagnostics,
 * so it travels through the global error handler and therefore gets the
 * standard error envelope and `requestId` like every other failure.
 *
 * Redaction happens in the constructor rather than at the call site: raw
 * simulation payloads contain account addresses, balances, XDR and
 * signatures, so no caller can accidentally publish them by constructing
 * this error with unredacted input.
 */
export class SimulationFailedError extends BadGatewayError {
  /**
   * Marker used instead of `instanceof`.
   *
   * `AppError` re-points `this` at `AppError.prototype`, which severs the
   * prototype chain of every subclass, so `err instanceof
   * SimulationFailedError` is always false. `isAppError` already works around
   * this with a flag; this mirrors that pattern.
   */
  public readonly isSimulationFailedError = true;

  constructor(
    message: string = "Soroban simulation failed",
    simulationDetails?: unknown,
  ) {
    super(
      message,
      "SIMULATION_FAILED",
      simulationDetails === undefined
        ? undefined
        : redactSimulationDetails(simulationDetails),
    );
    this.name = "SimulationFailedError";
  }
}

/**
 * Type guard for {@link SimulationFailedError}.
 *
 * Used by the error handler so simulation details are only ever read off an
 * error this codebase constructed (and therefore only ever read in a
 * redacted form).
 */
export function isSimulationFailedError(err: unknown): err is SimulationFailedError {
  return (
    !!err &&
    typeof err === "object" &&
    (err as Record<string, unknown>).isSimulationFailedError === true
  );
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
