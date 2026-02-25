import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedUser } from '../types/auth.js';

export interface AuthenticatedLocals {
  authenticatedUser?: AuthenticatedUser;
}

export const requireAuth = (
  req: Request,
  res: Response<unknown, AuthenticatedLocals>,
  next: NextFunction
): void => {
  const userId = req.header('x-user-id');
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.locals.authenticatedUser = { id: userId };
  next();
};
