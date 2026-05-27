import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { config } from '../config/index.js';
import { pool } from '../db.js';
import { logger } from '../logger.js';

/**
 * Recursively sort keys of an object to ensure stable stringification.
 */
function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, any> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = sortObjectKeys(obj[key]);
  }
  return sortedObj;
}

/**
 * Calculates SHA-256 hash of request metadata and body.
 */
export function calculateRequestHash(
  userId: string | undefined,
  body: unknown,
  method: string,
  path: string
): string {
  const cleanBody = JSON.parse(JSON.stringify(body || {})) as Record<string, unknown>;
  delete cleanBody.idempotencyKey;

  const sortedBody = sortObjectKeys(cleanBody);

  const payload = {
    userId: userId ?? '',
    method,
    path,
    body: sortedBody,
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Express middleware to enforce idempotency using Idempotency-Key header.
 */
export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
  const db = req.app?.locals?.dbPool ?? pool;

  const headerKey = req.header('idempotency-key') || req.header('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey;
  const rawKey = headerKey || bodyKey;

  if (!rawKey || typeof rawKey !== 'string') {
    return next();
  }

  const idempotencyKey = rawKey.trim();
  if (!idempotencyKey) {
    return next();
  }

  const userId = res.locals.authenticatedUser?.id;
  const requestHash = calculateRequestHash(userId, req.body, req.method, req.path);

  try {
    // Delete expired keys first to keep DB clean and release keys
    await db.query(
      'DELETE FROM idempotency_store WHERE expires_at < NOW()::timestamp OR expires_at < $1',
      [new Date().toISOString()]
    );

    // Look up the key
    const result = await db.query(
      'SELECT request_hash, status, response_status, response_body, expires_at FROM idempotency_store WHERE idempotency_key = $1',
      [idempotencyKey]
    );

    if (result.rows.length > 0) {
      const record = result.rows[0];
      const now = new Date();
      const expiresAt = new Date(record.expires_at);

      if (expiresAt > now) {
        if (record.request_hash !== requestHash) {
          logger.warn(`Idempotency key mismatch for key: ${idempotencyKey}`);
          res.status(409).json({
            error: 'Conflict',
            message: 'Idempotency key conflict: payload mismatch',
            code: 'IDEMPOTENCY_CONFLICT',
          });
          return;
        }

        if (record.status === 'completed') {
          logger.info(`Replaying cached response for idempotency key: ${idempotencyKey}`);
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(record.response_status).json(JSON.parse(record.response_body));
          return;
        } else if (record.status === 'started') {
          logger.warn(`Request in progress for idempotency key: ${idempotencyKey}`);
          res.status(409).json({
            error: 'Conflict',
            message: 'Request already in progress',
            code: 'IDEMPOTENCY_IN_PROGRESS',
          });
          return;
        }
      }
    }

    // Insert 'started' record
    const retentionSeconds = config.idempotency.retentionWindowSeconds;
    const expiresAtDate = new Date(Date.now() + retentionSeconds * 1000);

    await db.query(
      `INSERT INTO idempotency_store (idempotency_key, request_hash, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, NOW()::timestamp)`,
      [idempotencyKey, requestHash, 'started', expiresAtDate.toISOString()]
    );

    // Intercept response
    const originalSend = res.send;
    const originalJson = res.json;
    let saved = false;

    const saveResponse = async (status: number, body: unknown) => {
      if (saved) return;
      saved = true;

      try {
        if (status >= 500) {
          // Transient error: delete the key so client can retry
          await db.query('DELETE FROM idempotency_store WHERE idempotency_key = $1', [idempotencyKey]);
        } else {
          // Permanent result: cache it
          let bodyStr = '';
          if (typeof body === 'string') {
            bodyStr = body;
          } else {
            bodyStr = JSON.stringify(body);
          }

          try {
            JSON.parse(bodyStr);
          } catch {
            bodyStr = JSON.stringify({ message: bodyStr });
          }

          await db.query(
            `UPDATE idempotency_store
             SET status = $1, response_status = $2, response_body = $3
             WHERE idempotency_key = $4`,
            ['completed', status, bodyStr, idempotencyKey]
          );
        }
      } catch (err) {
        logger.error(`Failed to save idempotency response for key ${idempotencyKey}:`, err);
      }
    };

    res.send = function (body) {
      saveResponse(res.statusCode, body).catch(err => {
        logger.error('Unhandled idempotency saveResponse error:', err);
      });
      return originalSend.call(this, body);
    };

    res.json = function (body) {
      saveResponse(res.statusCode, body).catch(err => {
        logger.error('Unhandled idempotency saveResponse error:', err);
      });
      return originalJson.call(this, body);
    };

    next();
  } catch (error) {
    logger.error('Idempotency middleware error:', error);
    next(error);
  }
}
