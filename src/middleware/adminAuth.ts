import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { InternalServerError, UnauthorizedError } from '../errors/index.js';
import { timingSafeStringEqual } from '../lib/timingSafe.js';

interface AdminJwtPayload {
  role: string;
  [key: string]: unknown;
}

// #1266: the constant-time comparison formerly defined here now lives in
// src/lib/timingSafe.ts so the metrics endpoint (and any other secret check)
// shares one implementation. The shared version compares SHA-256 digests, so
// it no longer leaks the configured key's length either.

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  // Path 1: API key header — use timing-safe comparison to prevent key enumeration
  const apiKey = req.header('x-admin-api-key');
  const configuredKey = process.env.ADMIN_API_KEY;
  if (apiKey && configuredKey && timingSafeStringEqual(apiKey, configuredKey)) {
    res.locals.adminActor = 'admin-api-key';
    next();
    return;
  }

  // Path 2: Bearer JWT with admin role
  const authHeader = req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      next(new InternalServerError('JWT_SECRET not configured'));
      return;
    }

    try {
      const payload = jwt.verify(token, secret) as AdminJwtPayload;
      if (payload.role === 'admin') {
        res.locals.adminActor = (payload.sub as string) || (payload.email as string) || 'admin-jwt';
        next();
        return;
      }
    } catch {
      // Fall through to 401
    }
  }

  next(new UnauthorizedError('Unauthorized: admin access required'));
}
