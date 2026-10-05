/**
 * Example: a receiver endpoint that verifies inbound Callora webhook
 * deliveries using the same HMAC-SHA256 scheme as src/webhooks/webhook.signature.ts.
 *
 * The platform no longer ships a production route for this — see
 * docs/webhooks.md. Run locally with:
 *
 *   npx tsx examples/webhook-receiver.ts
 */
import express, { Request, Response, NextFunction } from 'express';
import {
  captureRawBody,
  verifyWebhookSignature,
  parseCapturedJson,
} from '../src/webhooks/webhook.signature.js';

const app = express();
const PORT = Number(process.env.PORT ?? 4100);

// In a real deployment, look the secret up from your subscription record
// instead of a hard-coded constant.
const WEBHOOK_SECRETS = (process.env.WEBHOOK_SECRETS ?? 'example-secret').split(',');

app.post(
  '/webhooks',
  captureRawBody,
  (req: Request & { webhookSecrets?: string[] }, _res: Response, next: NextFunction) => {
    req.webhookSecrets = WEBHOOK_SECRETS;
    next();
  },
  verifyWebhookSignature,
  parseCapturedJson,
  (req: Request, res: Response) => {
    const event = (req.body as { event?: string })?.event ?? 'unknown';
    console.log('[webhook-receiver] verified delivery:', event);
    res.status(200).json({ message: 'Webhook delivery accepted.', event });
  },
);

app.listen(PORT, () => {
  console.log(`webhook-receiver listening on http://localhost:${PORT}/webhooks`);
});
