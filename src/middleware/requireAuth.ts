import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedUser } from '../types/auth.js';
import { UnauthorizedError } from '../errors/index.js';

export interface AuthenticatedLocals {
  authenticatedUser?: AuthenticatedUser;
}

export const requireAuth = (
  req: Request,
  res: Response<unknown, AuthenticatedLocals>,
  next: NextFunction
): void => {
  let userId: string | undefined;

  const authHeader = req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    userId = authHeader.slice('Bearer '.length).trim();
  } else {
    userId = req.header('x-user-id');
  }

  if (!userId) {
    next(new UnauthorizedError());
    return;
  }

  res.locals.authenticatedUser = { id: userId };
  next();
};
