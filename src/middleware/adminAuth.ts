import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { InternalServerError, UnauthorizedError } from '../errors/index.js';

interface AdminJwtPayload { role: string; [key: string]: unknown }

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Require the configured admin API key or an admin-role JWT. */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header('x-admin-api-key');
  const configuredKey = process.env.ADMIN_API_KEY;
  if (apiKey && configuredKey && timingSafeStringEqual(apiKey, configuredKey)) {
    res.locals.adminActor = 'admin-api-key';
    next();
    return;
  }

  const authHeader = req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      next(new InternalServerError('JWT_SECRET not configured'));
      return;
    }
    try {
      const payload = jwt.verify(authHeader.slice(7), secret) as AdminJwtPayload;
      if (payload.role === 'admin') {
        res.locals.adminActor = (payload.sub as string) || (payload.email as string) || 'admin-jwt';
        next();
        return;
      }
    } catch {
      // Fall through to the standard unauthorized response.
    }
  }

  next(new UnauthorizedError('Unauthorized: admin access required'));
}
