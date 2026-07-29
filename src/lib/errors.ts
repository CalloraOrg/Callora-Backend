/**
 * Custom error classes for resilience patterns and HTTP error mapping.
 */

/**
 * Thrown when the circuit breaker is in OPEN state and requests are being rejected.
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string = 'Circuit breaker is open') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    Object.setPrototypeOf(this, CircuitBreakerOpenError.prototype);
  }
}

/**
 * Thrown when all retry attempts have been exhausted.
 */
export class RetryExhaustedError extends Error {
  public readonly attempts: number;
  public readonly lastError: Error;

  constructor(attempts: number, lastError: Error) {
    super(`Retry exhausted after ${attempts} attempts: ${lastError.message}`);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
    Object.setPrototypeOf(this, RetryExhaustedError.prototype);
  }
}

/**
 * HTTP 502 Bad Gateway error for upstream service failures.
 */
export class BadGatewayError extends Error {
  public readonly statusCode: number = 502;

  constructor(message: string = 'Bad Gateway') {
    super(message);
    this.name = 'BadGatewayError';
    Object.setPrototypeOf(this, BadGatewayError.prototype);
  }
}

/**
 * HTTP 400 Bad Request error for invalid client input.
 */
export class BadRequestError extends Error {
  public readonly statusCode: number = 400;

  constructor(message: string = 'Bad Request') {
    super(message);
    this.name = 'BadRequestError';
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}
