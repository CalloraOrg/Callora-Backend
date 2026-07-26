import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';

/**
 * Generates an ETag based on the content string or buffer.
 * By default generates a weak ETag unless strong is true.
 */
export function generateETag(content: string | Buffer, strong: boolean = false): string {
  const hash = createHash('sha1').update(content).digest('base64');
  const tag = hash.substring(0, 27);
  return strong ? `"${tag}"` : `W/"${tag}"`;
}

/**
 * ETag middleware for conditional GETs.
 * Checks If-None-Match header and returns 304 if matches.
 */
export function etagMiddleware(req: Request, res: Response, next: NextFunction): void;
export function etagMiddleware(options: { strong?: boolean }): (req: Request, res: Response, next: NextFunction) => void;
export function etagMiddleware(
  reqOrOptions?: Request | { strong?: boolean },
  res?: Response,
  next?: NextFunction
) {
  if (reqOrOptions && typeof reqOrOptions === 'object' && !('method' in reqOrOptions)) {
    const options = reqOrOptions as { strong?: boolean };
    const strong = options.strong ?? false;
    return function (req: Request, res: Response, next: NextFunction) {
      return executeEtag(req, res, next, strong);
    };
  }
  return executeEtag(reqOrOptions as Request, res as Response, next as NextFunction, false);
}

function executeEtag(req: Request, res: Response, next: NextFunction, strong: boolean) {
  // Only process GET and HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }

  const originalSend = res.send;

  res.send = function (body?: unknown): Response {
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
      entityTag = generateETag(content, strong);
    }

    if (entityTag) {
      res.setHeader('ETag', entityTag);

      const ifNoneMatch = req.header('if-none-match');
      if (ifNoneMatch) {
        // Handle client sending multiple ETags or wrapped in quotes
        const clientTags = ifNoneMatch.split(',').map(t => t.trim());
        const cleanTag = entityTag.replace('W/', '');
        if (
          clientTags.includes(entityTag) ||
          clientTags.includes(cleanTag) ||
          clientTags.includes(`"${cleanTag.replace(/"/g, '')}"`)
        ) {
          res.status(304);
          return originalSend.call(this, '');
        }
      }
    }

    return originalSend.call(this, body);
  };

  next();
}
