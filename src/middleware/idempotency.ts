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

export interface IdempotencyLease {
  renew(): Promise<void>;
}
interface CachedResponse {
  headers: Record<string, string>;
  bytes: number;
  sha256: string;
  body?: string;
}
const RESPONSE_PREFIX = 'idempotency-response-v1\n';
const MAX_REPLAY_BYTES = 256 * 1024;

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
  // Namespace keys per authenticated principal so the same key chosen by two
  // different users (or admin actors) cannot collide, mismatch, or replay
  // across tenants. Unauthenticated callers share the explicit 'anonymous'
  // scope.
  const scope = userId ?? (res.locals as { adminActor?: string }).adminActor ?? 'anonymous';
  const requestHash = calculateRequestHash(userId, req.body, req.method, req.path, bodyExcludingKeys);

  try {
    const leaseInterval = `${config.idempotency.leaseSeconds} seconds`;
    const select = () => db.query(
      `SELECT request_hash, status, response_status, response_body
       FROM idempotency_store
       WHERE scope = $1 AND idempotency_key = $2 AND expires_at > NOW()::timestamp`,
      [scope, idempotencyKey]
    );
    const handleExistingRecord = (record: {
      request_hash: string; status: string; response_status: number; response_body: string;
    }): boolean => {
      if (record.request_hash !== requestHash) {
        logger.warn('[idempotency] key reuse with mismatched payload', { requestId, correlationId, idempotencyKey });
        sendIdempotencyError(req, res, 409, opts?.conflictErrorCode ?? IDEMPOTENCY_KEY_REUSE_MISMATCH,
          'Idempotency key has already been used with a different request payload. Use a new idempotency key for a different request.', {
            idempotencyKey,
            incomingPayloadFingerprint: requestHash,
            storedPayloadFingerprint: record.request_hash,
            incomingFields: Object.keys(typeof req.body === 'object' && req.body !== null ? req.body : {}).sort(),
          });
        return true;
      }
      if (record.status !== 'completed') return false;
      res.setHeader('Idempotent-Replayed', 'true');
      // Old deployments stored JSON directly. The non-JSON prefix cannot collide
      // with any legacy JSON response, including strings and arbitrary objects.
      if (!record.response_body.startsWith(RESPONSE_PREFIX)) {
        res.status(record.response_status).json(JSON.parse(record.response_body));
        return true;
      }
      const cached = JSON.parse(record.response_body.slice(RESPONSE_PREFIX.length)) as CachedResponse;
      if (cached.body === undefined) {
        sendIdempotencyError(req, res, 409, 'IDEMPOTENCY_RESPONSE_TOO_LARGE',
          'The original response exceeded the replay limit. Fetch the resource using its identifier instead of repeating the operation.',
          { sha256: cached.sha256, bytes: cached.bytes });
        return true;
      }
      for (const [name, value] of Object.entries(cached.headers)) res.setHeader(name, value);
      res.status(record.response_status).end(Buffer.from(cached.body, 'base64'));
      return true;
    };

    const existing = await select();
    if (existing.rows[0] && handleExistingRecord(existing.rows[0])) return;
    let acquired;
    if (existing.rows[0]) {
      acquired = await db.query(
        `UPDATE idempotency_store SET lease_expires_at = NOW()::timestamp + $4::interval
         WHERE scope = $1 AND idempotency_key = $2 AND request_hash = $3
           AND status = 'started' AND lease_expires_at < NOW()::timestamp
           AND expires_at > NOW()::timestamp
         RETURNING to_char(lease_expires_at, 'YYYY-MM-DD HH24:MI:SS.US') AS lease_token`,
        [scope, idempotencyKey, requestHash, leaseInterval]
      );
    } else {
      acquired = await db.query(
        `INSERT INTO idempotency_store (scope, idempotency_key, request_hash, status, expires_at, created_at, lease_expires_at)
         VALUES ($1, $2, $3, 'started', NOW()::timestamp + $4::interval, NOW()::timestamp, NOW()::timestamp + $5::interval)
         ON CONFLICT (scope, idempotency_key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, status = EXCLUDED.status,
             response_status = NULL, response_body = NULL, expires_at = EXCLUDED.expires_at,
             created_at = EXCLUDED.created_at, lease_expires_at = EXCLUDED.lease_expires_at
         WHERE idempotency_store.expires_at <= NOW()::timestamp
         RETURNING to_char(lease_expires_at, 'YYYY-MM-DD HH24:MI:SS.US') AS lease_token`,
        [scope, idempotencyKey, requestHash,
          `${opts?.retentionSeconds ?? config.idempotency.retentionWindowSeconds} seconds`, leaseInterval]
      );
    }
    if (!acquired.rows[0]) {
      const raced = await select();
      if (raced.rows[0] && handleExistingRecord(raced.rows[0])) return;
      sendIdempotencyError(req, res, 409, opts?.inProgressErrorCode ?? 'IDEMPOTENCY_IN_PROGRESS', 'Request already in progress');
      return;
    }

    // Keep the database's full timestamp precision: a JS Date truncates PostgreSQL
    // microseconds and would make the ownership equality check fail.
    let leaseToken: string = acquired.rows[0].lease_token;
    let finished = false;
    let closed = false;
    let pending: Promise<unknown> = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const task = pending.then(operation);
      pending = task.catch(() => undefined);
      return task;
    };
    const release = () => db.query(
      `DELETE FROM idempotency_store WHERE scope = $1 AND idempotency_key = $2
       AND status = 'started' AND lease_expires_at = $3::timestamp`,
      [scope, idempotencyKey, leaseToken]
    );
    res.locals.idempotency = {
      renew: () => serialize(async () => {
        if (finished || closed) throw new Error('Idempotency response already ended');
        const renewed = await db.query(
          `UPDATE idempotency_store SET lease_expires_at = NOW()::timestamp + $4::interval
           WHERE scope = $1 AND idempotency_key = $2 AND status = 'started'
             AND lease_expires_at = $3::timestamp AND lease_expires_at > NOW()::timestamp
           RETURNING to_char(lease_expires_at, 'YYYY-MM-DD HH24:MI:SS.US') AS lease_token`,
          [scope, idempotencyKey, leaseToken, leaseInterval]
        );
        if (!renewed.rows[0]) throw new Error('Idempotency lease ownership lost');
        leaseToken = renewed.rows[0].lease_token;
      }),
    } satisfies IdempotencyLease;

    // One bounded buffer also avoids per-chunk overhead for tiny writes.
    let captured: Buffer | undefined;
    let bytes = 0;
    const hash = createHash('sha256');
    const capture = (chunk: unknown, encoding?: unknown) => {
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return;
      const charset = typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8';
      const offset = bytes;
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, charset) : chunk.length;
      if (typeof chunk === 'string') hash.update(chunk, charset);
      else hash.update(chunk);
      if (bytes <= MAX_REPLAY_BYTES) {
        captured ??= Buffer.allocUnsafe(MAX_REPLAY_BYTES);
        if (typeof chunk === 'string') captured.write(chunk, offset, charset);
        else captured.set(chunk, offset);
      } else captured = undefined;
    };
    const originalWrite = res.write;
    const originalEnd = res.end;
    res.write = function (this: Response, ...args: Parameters<Response['write']>) {
      capture(args[0], args[1]);
      return originalWrite.apply(this, args);
    } as Response['write'];
    res.end = function (this: Response, ...args: Parameters<Response['end']>) {
      capture(args[0], args[1]);
      return originalEnd.apply(this, args);
    } as Response['end'];
    const logFailure = (err: unknown) => logger.error('[idempotency] failed to save response', {
      requestId, correlationId, idempotencyKey, err,
    });
    res.once('finish', () => {
      finished = true;
      void serialize(async () => {
        try {
          if (res.statusCode >= 500) { await release(); return; }
          const headers: Record<string, string> = {};
          for (const name of ['content-type', 'content-encoding']) {
            const value = res.getHeader(name);
            if (typeof value === 'string') headers[name] = value;
          }
          const cached: CachedResponse = { headers, bytes, sha256: hash.digest('hex') };
          if (bytes <= MAX_REPLAY_BYTES) cached.body = captured ? captured.toString('base64', 0, bytes) : '';
          await db.query(
            `UPDATE idempotency_store SET status = 'completed', response_status = $1, response_body = $2
             WHERE scope = $3 AND idempotency_key = $4 AND status = 'started'
               AND lease_expires_at = $5::timestamp`,
            [res.statusCode, RESPONSE_PREFIX + JSON.stringify(cached), scope, idempotencyKey, leaseToken]
          );
        } catch (err) {
          logFailure(err);
          // A failed save must not strand the key until retention expires.
          // If the database is unavailable even for cleanup, the lease bounds it.
          await release();
        }
      }).catch(logFailure);
    });
    res.once('close', () => {
      closed = true;
      if (!finished) void serialize(release).catch(logFailure);
    });

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
