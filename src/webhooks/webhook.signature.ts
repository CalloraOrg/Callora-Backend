import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

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
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Express middleware: verify the HMAC-SHA256 signature on incoming webhook deliveries.
 *
 * Expects:
 *   - `req.webhookSecret` (string)  attached upstream (e.g. by the route handler after
 *     looking up the developer's stored secret).
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
  req: Request & { webhookSecret?: string; rawBody?: Buffer },
  res: Response,
  next: NextFunction
): void {
  const secret = req.webhookSecret;

  // No secret configured → skip verification (opt-in feature)
  if (!secret) {
    return next();
  }

  const sigHeader = req.headers[SIGNATURE_HEADER] as string | undefined;
  const tsHeader = req.headers[TIMESTAMP_HEADER] as string | undefined;

  if (!sigHeader || !tsHeader) {
    res.status(401).json({
      error: `Missing required headers: ${SIGNATURE_HEADER}, ${TIMESTAMP_HEADER}.`,
    });
    return;
  }

  // Validate timestamp format and staleness
  const deliveryTime = Date.parse(tsHeader);
  if (Number.isNaN(deliveryTime)) {
    res.status(401).json({ error: 'Invalid timestamp format in x-callora-timestamp.' });
    return;
  }

  if (Math.abs(Date.now() - deliveryTime) > SIGNATURE_TOLERANCE_MS) {
    res.status(401).json({ error: 'Webhook timestamp is too old or too far in the future.' });
    return;
  }

  // Extract hex digest from "sha256=<hex>"
  const parts = sigHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256' || !parts[1]) {
    res.status(401).json({
      error: `Malformed ${SIGNATURE_HEADER} header. Expected format: sha256=<hex>.`,
    });
    return;
  }
  const receivedHex = parts[1];

  const rawBody = req.rawBody ?? Buffer.alloc(0);
  const expectedHex = computeSignature(secret, tsHeader, rawBody);

  if (!safeCompare(expectedHex, receivedHex)) {
    res.status(401).json({ error: 'Webhook signature verification failed.' });
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