import { Request, Response, NextFunction } from 'express';
import type { AuthenticatedLocals } from '../middleware/requireAuth.js';

/**
 * Wraps an async Express route handler so that any thrown error is forwarded
 * to the next() error-handling middleware. Express 4 does not automatically
 * catch rejected promises from async handlers.
 *
 * Usage:
 *   app.get('/path', asyncHandler(async (req, res) => {
 *     const data = await someAsyncOperation();
 *     res.json(data);
 *   }));
 *
 * Errors thrown in the handler (or rejected promises) are caught and passed
 * to Express's error handler via next(err).
 */
export function asyncHandler(
  fn: (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => Promise<void>,
): (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => void {
  return (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
