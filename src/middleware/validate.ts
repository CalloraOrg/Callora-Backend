import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { BadRequestError } from '../errors/index.js';

/**
 * Interface for validation schemas
 */
export interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Interface for validation error details
 */
export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

/**
 * Interface for validation error response body
 */
export interface ValidationErrorResponse {
  error: string;
  code: string;
  details: ValidationError[];
}

/**
 * Creates a validation middleware that validates request body, query parameters, and route parameters
 * using Zod schemas. If validation fails, it throws a BadRequestError with detailed error information.
 * 
 * @param schemas - Object containing Zod schemas for body, query, and/or params
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { validate } from '../middleware/validate.js';
 * 
 * const userSchema = z.object({
 *   name: z.string().min(2),
 *   email: z.string().email(),
 *   age: z.number().min(18)
 * });
 * 
 * const querySchema = z.object({
 *   page: z.string().transform(Number).pipe(z.number().min(1)).default('1'),
 *   limit: z.string().transform(Number).pipe(z.number().max(100)).default('20')
 * });
 * 
 * router.post('/users', 
 *   validate({ body: userSchema, query: querySchema }),
 *   createUserHandler
 * );
 * ```
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const errors: ValidationError[] = [];

    // Validate request body
    if (schemas.body) {
      try {
        schemas.body.parse(req.body);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...formatZodErrors(err, 'body'));
        } else {
          errors.push({
            field: 'body',
            message: 'Invalid request body format',
            code: 'INVALID_BODY'
          });
        }
      }
    }

    // Validate query parameters
    if (schemas.query) {
      try {
        schemas.query.parse(req.query);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...formatZodErrors(err, 'query'));
        } else {
          errors.push({
            field: 'query',
            message: 'Invalid query parameters format',
            code: 'INVALID_QUERY'
          });
        }
      }
    }

    // Validate route parameters
    if (schemas.params) {
      try {
        schemas.params.parse(req.params);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...formatZodErrors(err, 'params'));
        } else {
          errors.push({
            field: 'params',
            message: 'Invalid route parameters format',
            code: 'INVALID_PARAMS'
          });
        }
      }
    }

    // If there are validation errors, throw a BadRequestError
    if (errors.length > 0) {
      throw new BadRequestError(
        'Request validation failed',
        'VALIDATION_ERROR'
      );
    }

    next();
  };
}

/**
 * Formats Zod validation errors into a consistent format
 * 
 * @param error - ZodError instance
 * @param location - Location of the validation error ('body', 'query', or 'params')
 * @returns Array of formatted validation errors
 */
function formatZodErrors(error: ZodError, location: string): ValidationError[] {
  return error.errors.map((err): ValidationError => {
    const field = err.path.join('.');
    const code = err.code.toUpperCase();
    
    // Map Zod error codes to user-friendly messages
    let message = err.message;
    switch (err.code) {
      case 'invalid_string':
        message = `Invalid ${field}: ${err.message}`;
        break;
      case 'invalid_type':
        message = `Invalid ${field}: expected ${err.expected}, received ${err.received}`;
        break;
      case 'too_small':
        message = `${field} is too small: ${err.message}`;
        break;
      case 'too_big':
        message = `${field} is too big: ${err.message}`;
        break;
      case 'invalid_enum_value':
        message = `Invalid ${field}: must be one of ${err.options?.join(', ')}`;
        break;
      default:
        message = `${field}: ${err.message}`;
    }

    return {
      field: `${location}.${field}`,
      message,
      code
    };
  });
}

/**
 * Enhanced BadRequestError that includes validation details
 * This can be used when you need to access validation error details in error handling
 */
export class ValidationError extends BadRequestError {
  public readonly details: ValidationError[];

  constructor(details: ValidationError[]) {
    super('Request validation failed', 'VALIDATION_ERROR');
    this.details = details;
  }
}

/**
 * Alternative validation middleware that returns detailed validation errors
 * Use this when you want to include validation error details in the response
 * 
 * @param schemas - Object containing Zod schemas for body, query, and/or params
 * @returns Express middleware function
 */
export function validateWithDetails(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: ValidationError[] = [];

    // Validate request body
    if (schemas.body) {
      try {
        schemas.body.parse(req.body);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...formatZodErrors(err, 'body'));
        }
      }
    }

    // Validate query parameters
    if (schemas.query) {
      try {
        schemas.query.parse(req.query);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...formatZodErrors(err, 'query'));
        }
      }
    }

    // Validate route parameters
    if (schemas.params) {
      try {
        schemas.params.parse(req.params);
      } catch (err) {
        if (err instanceof ZodError) {
          errors.push(...formatZodErrors(err, 'params'));
        }
      }
    }

    // If there are validation errors, return detailed error response
    if (errors.length > 0) {
      const responseBody: ValidationErrorResponse = {
        error: 'Request validation failed',
        code: 'VALIDATION_ERROR',
        details: errors
      };
      
      res.status(400).json(responseBody);
      return;
    }

    next();
  };
}
