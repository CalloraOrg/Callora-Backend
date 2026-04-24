import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface AdminJwtPayload {
  role: string;
  [key: string]: unknown;
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  // Path 1: API key header
  const apiKey = req.header('x-admin-api-key');
  if (apiKey && apiKey === process.env.ADMIN_API_KEY) {
    next();
    return;
  }

  // Path 2: Bearer JWT with admin role
  const authHeader = req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      res.status(500).json({ error: 'JWT_SECRET not configured' });
      return;
    }

    try {
      const payload = jwt.verify(token, secret) as AdminJwtPayload;
      if (payload.role === 'admin') {
        next();
        return;
      }
    } catch {
      // Fall through to 401
    }
  }

  res.status(401).json({ error: 'Unauthorized: admin access required' });
}
