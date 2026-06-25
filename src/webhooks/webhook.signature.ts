import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { BadRequestError, UnauthorizedError } from '../errors/index.js';

export const SIGNATURE_HEADER = 'x-callora-signature-256';
export const TIMESTAMP_HEADER = 'x-callora-timestamp';

/**
 * Maximum age (ms) of a webhook request before it is rejected as a replay.
 * Default: 5 minutes.
 */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Compute the expected HMAC-SHA256 signature for a webhook delivery.
 *
 * The signed payload is:  `<timestamp>.<rawBody>`
 * This ties the signature to both the content and the delivery time,
 * preventing replay attacks even when the same payload is re-sent.
 *
 * @param secret    - Shared secret stored at registration time.
 * @param timestamp - ISO-8601 delivery timestamp (from x-callora-timestamp header).
 * @param rawBody   - Raw request body bytes (Buffer or string).
 */
export function computeSignature(
  secret: string,
  timestamp: string,
  rawBody: Buffer | string
): string {
  const payload = `${timestamp}.${rawBody.toString()}`;
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
 * Express middleware: verify the HMAC-SHA256 signature on incoming webhook deliveries.
 *
 * Expects:
 *   - `req.webhookSecret` (string)  attached upstream (e.g. by the route handler after
 *     looking up the developer's stored secret).
 *   - or `req.webhookSecrets` (string[]) containing current and unexpired previous secrets.
 *   - `x-callora-signature-256` header  — `sha256=<hex>`
 *   - `x-callora-timestamp`      header  — ISO-8601 string
 *   - `req.rawBody` (Buffer)             — populated by the `captureRawBody` middleware.
 *
 * If the secret is absent the middleware is a no-op (backwards compatible with
 * registrations made without a secret).
 *
 * Rejects with 401 when:
 *   - Headers are missing
 *   - Timestamp is stale (> SIGNATURE_TOLERANCE_MS)
 *   - Signature does not match
 */
export function verifyWebhookSignature(
  req: Request & { webhookSecret?: string; webhookSecrets?: string[]; rawBody?: Buffer },
  _res: Response,
  next: NextFunction
): void {
  const secrets = req.webhookSecrets ?? (req.webhookSecret ? [req.webhookSecret] : []);

  // No secret configured → skip verification (opt-in feature)
  if (secrets.length === 0) {
    return next();
  }

  const sigHeader = req.headers[SIGNATURE_HEADER] as string | undefined;
  const tsHeader = req.headers[TIMESTAMP_HEADER] as string | undefined;

  if (!sigHeader || !tsHeader) {
    next(new UnauthorizedError(
      `Missing required headers: ${SIGNATURE_HEADER}, ${TIMESTAMP_HEADER}.`,
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

  const rawBody = req.rawBody ?? Buffer.alloc(0);
  const hasValidSignature = secrets.some((secret) => {
    const expectedHex = computeSignature(secret, tsHeader, rawBody);
    return safeCompare(expectedHex, receivedHex);
  });

  if (!hasValidSignature) {
    next(new UnauthorizedError(
      'Webhook signature verification failed.',
      'INVALID_WEBHOOK_SIGNATURE'
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
