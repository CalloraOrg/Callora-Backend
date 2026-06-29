import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';

/**
 * Generates a weak ETag based on the content string or buffer.
 */
export function generateETag(content: string | Buffer): string {
  const hash = createHash('sha1').update(content).digest('base64');
  return `W/"${hash.substring(0, 27)}"`;
}

/**
 * ETag middleware for conditional GETs.
 * Checks If-None-Match header and returns 304 if matches.
 */
export function etagMiddleware(req: Request, res: Response, next: NextFunction) {
  // Only process GET and HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }

  const originalSend = res.send;

  res.send = function (body?: any): Response {
    // Only generate ETag for 200 OK responses where ETag is not already set
    if (res.statusCode !== 200 || res.get('ETag')) {
      return originalSend.call(this, body);
    }

    let entityTag: string | undefined;
    if (body !== undefined && body !== null) {
      let content: string | Buffer;
      if (typeof body === 'string') {
        content = body;
      } else if (Buffer.isBuffer(body)) {
        content = body;
      } else {
        content = JSON.stringify(body);
      }
      entityTag = generateETag(content);
    }

    if (entityTag) {
      res.setHeader('ETag', entityTag);

      const ifNoneMatch = req.header('if-none-match');
      if (ifNoneMatch) {
        // Handle client sending multiple ETags or wrapped in quotes
        const clientTags = ifNoneMatch.split(',').map(t => t.trim());
        if (clientTags.includes(entityTag) || clientTags.includes(entityTag.replace('W/', ''))) {
          res.status(304);
          return originalSend.call(this, '');
        }
      }
    }

    return originalSend.call(this, body);
  };

  next();
}
