import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { InternalServerError, UnauthorizedError } from '../errors/index.js';
import { ALLOWED_ALGORITHMS } from './requireAuth.js';
import { getTokenRevocationService } from '../services/tokenRevocation.js';
import { timingSafeStringEqual } from '../lib/timingSafe.js';

interface AdminJwtPayload { role: string; [key: string]: unknown }

// #1266: constant-time comparison lives in src/lib/timingSafe.ts (SHA-256
// digests compared with crypto.timingSafeEqual, so key length is not leaked).

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
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, secret, { algorithms: ALLOWED_ALGORITHMS }) as AdminJwtPayload;

      if (typeof payload.exp !== 'number') {
        throw new Error('Token missing exp claim');
      }

      if (payload.aud !== undefined && payload.aud !== 'admin') {
        throw new Error('Invalid audience');
      }

      const tokenHash = createHash('sha256').update(token).digest('hex');
      if (getTokenRevocationService().isRevoked(tokenHash)) {
        throw new Error('Token is revoked');
      }

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
