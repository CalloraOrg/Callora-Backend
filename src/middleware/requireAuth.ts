import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedUser } from '../types/auth.js';
import { UnauthorizedError } from '../errors/index.js';

export interface AuthenticatedLocals {
  authenticatedUser?: AuthenticatedUser;
}

// Extend Express Request to carry the authenticated developer id
declare module 'express-serve-static-core' {
  interface Request {
    developerId?: string;
  }
}

export const requireAuth = (
  req: Request,
  res: Response<unknown, AuthenticatedLocals>,
  next: NextFunction
): void => {
  const userId = req.header('x-user-id');
  if (!userId) {
    next(new UnauthorizedError());
    return;
  }

  res.locals.authenticatedUser = { id: userId };
  req.developerId = userId; // Keep req.developerId backwards compatibility since main branch router depends on it
  next();
};
