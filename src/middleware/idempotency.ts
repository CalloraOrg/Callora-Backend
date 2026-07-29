import type { NextFunction, Request, Response, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { config } from '../config/index.js';
import { pool } from '../db.js';
import { errorEnvelope } from '../lib/envelope.js';
import { logger } from '../logger.js';

export interface IdempotencyConfig {
  keyFromHeader?: string;
  keyFromBody?: string;
  bodyExcludingKeys?: string[];
  retentionSeconds?: number;
  cleanExpiredTTL?: boolean;
  conflictErrorCode?: string;
  inProgressErrorCode?: string;
  methods?: string[];
  allowBodyKey?: boolean;
  maxKeyLength?: number;
  keyPattern?: RegExp;
}

/**
 * Error code returned when a client reuses an idempotency key with a
 * different request payload. Distinct from IDEMPOTENCY_IN_PROGRESS so
 * callers can distinguish a body mismatch from a concurrent duplicate.
 */
export const IDEMPOTENCY_KEY_REUSE_MISMATCH = 'IDEMPOTENCY_KEY_REUSE_MISMATCH' as const;
export const INVALID_IDEMPOTENCY_KEY = 'INVALID_IDEMPOTENCY_KEY' as const;

const DEFAULT_IDEMPOTENCY_METHODS = ['POST', 'PATCH'];
const DEFAULT_KEY_MAX_LENGTH = 255;
const DEFAULT_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

function currentRequestId(req: Request): string {
  return req.id || 'unknown';
}

function currentCorrelationId(req: Request): string {
  return req.header('x-correlation-id') || currentRequestId(req);
}

function sendIdempotencyError(
  req: Request,
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
): void {
  res.status(statusCode).json(errorEnvelope(code, message, currentRequestId(req), details));
}

/**
 * Recursively sort keys of an object to ensure stable stringification.
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = sortObjectKeys(record[key]);
  }
  return sortedObj;
}

/**
 * Recursively removes specified keys from an object before hashing.
 */
function removeKeys(obj: unknown, keysToRemove: string[]): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => removeKeys(item, keysToRemove));
  }
  const record = obj as Record<string, unknown>;
  const filteredObj: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (!keysToRemove.includes(key)) {
      filteredObj[key] = removeKeys(record[key], keysToRemove);
    }
  }
  return filteredObj;
}

/**
 * Calculates SHA-256 hash of request metadata and body.
 */
export function calculateRequestHash(
  userId: string | undefined,
  body: unknown,
  method: string,
  path: string,
  bodyExcludingKeys: string[] = ['idempotencyKey']
): string {
  const cleanBody = JSON.parse(JSON.stringify(body || {})) as Record<string, unknown>;
  const filteredBody = removeKeys(cleanBody, bodyExcludingKeys);

  const sortedBody = sortObjectKeys(filteredBody);

  const payload = {
    userId: userId ?? '',
    method,
    path,
    body: sortedBody,
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function getRawIdempotencyKey(req: Request, opts?: IdempotencyConfig): unknown {
  const headerName = opts?.keyFromHeader ?? 'idempotency-key';
  const bodyKey = opts?.keyFromBody ?? 'idempotencyKey';
  return req.header(headerName) ?? (opts?.allowBodyKey === false ? undefined : req.body?.[bodyKey]);
}

/**
 * Idempotency middleware. It records the first non-5xx response for a key and
 * replays it for matching retries while rejecting mismatched payload reuse.
 */
export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
  opts?: IdempotencyConfig
): Promise<void> {
  const allowedMethods = opts?.methods ?? DEFAULT_IDEMPOTENCY_METHODS;
  if (!allowedMethods.includes(req.method.toUpperCase())) {
    next();
    return;
  }

  const db = (req.app?.locals?.dbPool ?? pool) as Pool;
  const bodyExcludingKeys = opts?.bodyExcludingKeys ?? ['idempotencyKey'];
  const rawKey = getRawIdempotencyKey(req, opts);

  if (!rawKey || typeof rawKey !== 'string') {
    next();
    return;
  }

  const idempotencyKey = rawKey.trim();
  if (!idempotencyKey) {
    next();
    return;
  }

  const requestId = currentRequestId(req);
  const correlationId = currentCorrelationId(req);
  const maxKeyLength = opts?.maxKeyLength ?? DEFAULT_KEY_MAX_LENGTH;
  const keyPattern = opts?.keyPattern ?? DEFAULT_KEY_PATTERN;

  if (idempotencyKey.length > maxKeyLength || !keyPattern.test(idempotencyKey)) {
    logger.warn('[idempotency] invalid key rejected', {
      requestId,
      correlationId,
      method: req.method,
      path: req.originalUrl ?? req.path,
      keyLength: idempotencyKey.length,
    });
    sendIdempotencyError(req, res, 400, INVALID_IDEMPOTENCY_KEY, 'Invalid Idempotency-Key header', {
      header: 'Idempotency-Key',
      maxLength: maxKeyLength,
      allowedCharacters: 'A-Z, a-z, 0-9, dot, underscore, colon, and hyphen',
    });
    return;
  }

  const userId = res.locals.authenticatedUser?.id;
  const requestHash = calculateRequestHash(userId, req.body, req.method, req.path, bodyExcludingKeys);

  try {
    if (opts?.cleanExpiredTTL ?? true) {
      await db.query('DELETE FROM idempotency_store WHERE expires_at < NOW()::timestamp', []);
    }
    await db.query('DELETE FROM idempotency_store WHERE expires_at < $1', [new Date().toISOString()]);

    const result = await db.query(
      'SELECT request_hash, status, response_status, response_body, expires_at FROM idempotency_store WHERE idempotency_key = $1',
      [idempotencyKey]
    );

    if (result.rows.length > 0) {
      const record = result.rows[0];
      const expiresAt = new Date(record.expires_at);

      if (expiresAt > new Date()) {
        if (record.request_hash !== requestHash) {
          logger.warn('[idempotency] key reuse with mismatched payload', {
            requestId,
            correlationId,
            idempotencyKey,
            storedHash: record.request_hash,
            incomingHash: requestHash,
            method: req.method,
            path: req.originalUrl ?? req.path,
          });

          const incomingKeys = Object.keys(
            typeof req.body === 'object' && req.body !== null ? req.body : {}
          ).sort();

          sendIdempotencyError(
            req,
            res,
            409,
            opts?.conflictErrorCode ?? IDEMPOTENCY_KEY_REUSE_MISMATCH,
            'Idempotency key has already been used with a different request payload. Use a new idempotency key for a different request.',
            {
              idempotencyKey,
              incomingPayloadFingerprint: requestHash,
              storedPayloadFingerprint: record.request_hash,
              incomingFields: incomingKeys,
            }
          );
          return;
        }

        if (record.status === 'completed') {
          logger.info('[idempotency] replaying cached response', {
            requestId,
            correlationId,
            idempotencyKey,
            method: req.method,
            path: req.originalUrl ?? req.path,
          });
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(record.response_status).json(JSON.parse(record.response_body));
          return;
        }

        if (record.status === 'started') {
          logger.warn('[idempotency] request already in progress', {
            requestId,
            correlationId,
            idempotencyKey,
            method: req.method,
            path: req.originalUrl ?? req.path,
          });
          sendIdempotencyError(
            req,
            res,
            409,
            opts?.inProgressErrorCode ?? 'IDEMPOTENCY_IN_PROGRESS',
            'Request already in progress'
          );
          return;
        }
      }
    }

    const retentionSeconds = opts?.retentionSeconds ?? config.idempotency.retentionWindowSeconds;
    const expiresAtDate = new Date(Date.now() + retentionSeconds * 1000);

    await db.query(
      `INSERT INTO idempotency_store (idempotency_key, request_hash, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, NOW()::timestamp)`,
      [idempotencyKey, requestHash, 'started', expiresAtDate.toISOString()]
    );

    const originalSend = res.send;
    const originalJson = res.json;
    let saved = false;

    const saveResponse = async (status: number, body: unknown) => {
      if (saved) return;
      saved = true;

      try {
        if (status >= 500) {
          await db.query('DELETE FROM idempotency_store WHERE idempotency_key = $1', [idempotencyKey]);
          return;
        }

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
      } catch (err) {
        logger.error('[idempotency] failed to save response', {
          requestId,
          correlationId,
          idempotencyKey,
          err,
        });
      }
    };

    res.send = function (body) {
      saveResponse(res.statusCode, body).catch(err => {
        logger.error('[idempotency] unhandled saveResponse error', {
          requestId,
          correlationId,
          idempotencyKey,
          err,
        });
      });
      return originalSend.call(this, body);
    };

    res.json = function (body) {
      saveResponse(res.statusCode, body).catch(err => {
        logger.error('[idempotency] unhandled saveResponse error', {
          requestId,
          correlationId,
          idempotencyKey,
          err,
        });
      });
      return originalJson.call(this, body);
    };

    next();
  } catch (error) {
    logger.error('[idempotency] middleware error', {
      requestId,
      correlationId,
      error,
    });
    next(error);
  }
}

/**
 * Factory that returns a 3-parameter Express RequestHandler for idempotencyMiddleware.
 * Express treats 4-parameter functions as error handlers, so this wrapper ensures
 * Express dispatches the middleware during normal request processing.
 */
export function createIdempotencyMiddleware(opts?: IdempotencyConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    idempotencyMiddleware(req, res, next, opts);
  };
}

