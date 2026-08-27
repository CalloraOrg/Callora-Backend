import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { BadRequestError, UnauthorizedError } from '../errors/index.js';
import { WebhookNonceStore } from './webhook.nonceStore.js';

export const SIGNATURE_HEADER = 'x-callora-signature-256';
export const TIMESTAMP_HEADER = 'x-callora-timestamp';
export const NONCE_HEADER = 'x-callora-nonce';

/**
 * Maximum age (ms) of a webhook request before it is rejected as a replay.
 * Default: 5 minutes. Nonce records use the same TTL.
 */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Nonce must be unique, URL-safe, and long enough to resist guessing. */
const NONCE_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;

const GENERIC_SIGNATURE_FAILURE = 'Webhook signature verification failed.';

/**
 * Compute the expected HMAC-SHA256 signature for a webhook delivery.
 *
 * The signed payload is:  `<timestamp>.<nonce>.<rawBody>` when a nonce is
 * supplied, otherwise `<timestamp>.<rawBody>` (legacy callers / unit tests).
 * Binding timestamp and nonce into the MAC prevents swapping either field
 * on a captured request.
 *
 * @param secret    - Shared secret stored at registration time.
 * @param timestamp - ISO-8601 delivery timestamp (from x-callora-timestamp header).
 * @param rawBody   - Raw request body bytes (Buffer or string).
 * @param nonce     - Unique request nonce (from x-callora-nonce header).
 */
export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: Buffer | string,
  nonce?: string
): string {
  const body = rawBody.toString();
  const payload =
    nonce !== undefined && nonce.length > 0
      ? `${timestamp}.${nonce}.${body}`
      : `${timestamp}.${body}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Perform a timing-safe comparison of two hex signature strings.
 * Returns false immediately if lengths differ (no timing info leaked beyond length).
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Compare `receivedHex` against every provided secret without short-circuiting.
 * Always walks the full list so the matched key cannot be inferred from timing
 * or from the failure response.
 *
 * @returns true when at least one secret matches; never identifies which one.
 */
export function matchesAnySecret(
  secrets: readonly string[],
  timestamp: string,
  rawBody: Buffer | string,
  receivedHex: string,
  nonce?: string
): boolean {
  let matched = 0;
  for (const secret of secrets) {
    const expectedHex = computeSignature(secret, timestamp, rawBody, nonce);
    if (safeCompare(expectedHex, receivedHex)) {
      matched = 1;
    }
  }
  return matched === 1;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function nonceScope(
  req: Request & { webhookNonceScope?: string }
): string {
  if (typeof req.webhookNonceScope === 'string' && req.webhookNonceScope.length > 0) {
    return req.webhookNonceScope;
  }
  const developerId = req.params?.developerId;
  return typeof developerId === 'string' && developerId.length > 0
    ? developerId
    : '_';
}

/**
 * Express middleware: verify the HMAC-SHA256 signature on incoming webhook deliveries.
 *
 * Expects:
 *   - `req.webhookSecret` (string)  attached upstream (e.g. by the route handler after
 *     looking up the developer's stored secret).
 *   - or `req.webhookSecrets` (string[]) containing current and unexpired previous secrets.
 *   - `x-callora-signature-256` header  — `sha256=<hex>`
 *   - `x-callora-timestamp`      header  — ISO-8601 string
 *   - `x-callora-nonce`          header  — unique request nonce
 *   - `req.rawBody` (Buffer)             — populated by the `captureRawBody` middleware.
 *
 * If the secret is absent the middleware is a no-op (backwards compatible with
 * registrations made without a secret).
 *
 * Rejects with 401 when:
 *   - Headers are missing
 *   - Timestamp is stale (> SIGNATURE_TOLERANCE_MS)
 *   - Signature does not match any active key
 *   - Nonce has already been consumed
 *
 * Failure responses never identify which key (current vs previous) was tested
 * or matched.
 */
export function verifyWebhookSignature(
  req: Request & {
    webhookSecret?: string;
    webhookSecrets?: string[];
    webhookNonceScope?: string;
    rawBody?: Buffer;
  },
  _res: Response,
  next: NextFunction
): void {
  const secrets = req.webhookSecrets ?? (req.webhookSecret ? [req.webhookSecret] : []);

  // No secret configured → skip verification (opt-in feature)
  if (secrets.length === 0) {
    return next();
  }

  const sigHeader = headerValue(req.headers[SIGNATURE_HEADER]);
  const tsHeader = headerValue(req.headers[TIMESTAMP_HEADER]);
  const nonceHeader = headerValue(req.headers[NONCE_HEADER]);

  if (!sigHeader || !tsHeader || !nonceHeader) {
    next(new UnauthorizedError(
      `Missing required headers: ${SIGNATURE_HEADER}, ${TIMESTAMP_HEADER}, ${NONCE_HEADER}.`,
      'MISSING_WEBHOOK_SIGNATURE_HEADERS'
    ));
    return;
  }

  // Validate timestamp format and staleness
  const deliveryTime = Date.parse(tsHeader);
  if (Number.isNaN(deliveryTime)) {
    next(new BadRequestError(
      'Invalid timestamp format in x-callora-timestamp.',
      'INVALID_WEBHOOK_TIMESTAMP'
    ));
    return;
  }

  if (Math.abs(Date.now() - deliveryTime) > SIGNATURE_TOLERANCE_MS) {
    next(new UnauthorizedError(
      'Webhook timestamp is too old or too far in the future.',
      'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW'
    ));
    return;
  }

  // Extract hex digest from "sha256=<hex>"
  const parts = sigHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256' || !parts[1]) {
    next(new BadRequestError(
      `Malformed ${SIGNATURE_HEADER} header. Expected format: sha256=<hex>.`,
      'MALFORMED_WEBHOOK_SIGNATURE'
    ));
    return;
  }
  const receivedHex = parts[1];

  if (!NONCE_PATTERN.test(nonceHeader)) {
    next(new BadRequestError(
      `Malformed ${NONCE_HEADER} header.`,
      'MALFORMED_WEBHOOK_NONCE'
    ));
    return;
  }

  const rawBody = req.rawBody ?? Buffer.alloc(0);
  const accepted = matchesAnySecret(secrets, tsHeader, rawBody, receivedHex, nonceHeader);

  if (!accepted) {
    next(new UnauthorizedError(
      GENERIC_SIGNATURE_FAILURE,
      'INVALID_WEBHOOK_SIGNATURE'
    ));
    return;
  }

  const consumed = WebhookNonceStore.consume(
    nonceScope(req),
    nonceHeader,
    SIGNATURE_TOLERANCE_MS
  );
  if (!consumed) {
    next(new UnauthorizedError(
      GENERIC_SIGNATURE_FAILURE,
      'WEBHOOK_NONCE_REPLAYED'
    ));
    return;
  }

  next();
}

/**
 * Express middleware: capture the raw request body into `req.rawBody`.
 *
 * Must be mounted BEFORE `express.json()` on the routes that need signature
 * verification, because `express.json()` consumes the stream and the raw bytes
 * become unavailable afterward.
 *
 * Usage:
 *   router.use(captureRawBody);
 *   router.use(express.json());
 */
export function captureRawBody(
  req: Request & { rawBody?: Buffer },
  _res: Response,
  next: NextFunction
): void {
  const chunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', next);
}

/**
 * Parse JSON from `req.rawBody` after `captureRawBody` has consumed the stream.
 * `express.json()` cannot re-read the request once the raw bytes are buffered.
 */
export function parseCapturedJson(
  req: Request & { rawBody?: Buffer },
  _res: Response,
  next: NextFunction
): void {
  if (!req.rawBody || req.rawBody.length === 0) {
    req.body = {};
    next();
    return;
  }

  try {
    req.body = JSON.parse(req.rawBody.toString());
    next();
  } catch {
    next(new BadRequestError('Invalid JSON body.', 'INVALID_BODY'));
  }
}
