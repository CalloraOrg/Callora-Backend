/**
 * Custom error classes for consistent HTTP error handling.
 * Use these in routes/services; the global error handler maps them to status codes and JSON.
 */

export class AppError extends Error {
  public readonly isAppError = true;

  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Bad request', code?: string) {
    super(message, 400, code ?? 'BAD_REQUEST');
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', code?: string) {
    super(message, 401, code ?? 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', code?: string) {
    super(message, 403, code ?? 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Not found', code?: string) {
    super(message, 404, code ?? 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class PaymentRequiredError extends AppError {
  constructor(message: string = 'Payment Required', code?: string) {
    super(message, 402, code ?? 'PAYMENT_REQUIRED');
    this.name = 'PaymentRequiredError';
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string = 'Too Many Requests', code?: string) {
    super(message, 429, code ?? 'TOO_MANY_REQUESTS');
    this.name = 'TooManyRequestsError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as Record<string, unknown>).isAppError === true
  );
}
