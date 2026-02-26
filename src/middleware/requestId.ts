import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithRequestContext } from '../logger.js';

const REQUEST_ID_HEADER = 'x-request-id';

export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const headerValue = req.header(REQUEST_ID_HEADER)?.trim();
  const requestId = headerValue?.length ? headerValue : uuidv4();

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  runWithRequestContext({ requestId }, () => next());
};
