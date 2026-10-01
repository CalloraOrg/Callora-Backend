Callora Webhook Documentation
Overview
Developers can register a webhook URL to receive real-time HTTP POST notifications
when specific events occur on the Callora platform.

Registration
POST /api/webhooks

Request Body
Field	Type	Required	Description
developerId	string	✅	Your developer ID
url	string	✅	HTTPS endpoint to receive events
events	string[]	✅	One or more event types (see below)
secret	string	❌	Used to sign payloads (recommended)
retryPolicy	object	optional	Optional per-subscription retry override
Request bodies are Zod-validated before registration logic runs. Unknown fields
are rejected.

Validation errors
Invalid registration and retry-policy requests return HTTP 400 using the
standard error envelope:

JSON

{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "body.url",
        "message": "url must be a valid absolute URL",
        "code": "INVALID_FORMAT"
      }
    ]
  },
  "requestId": "req-webhook-create",
  "timestamp": "2026-07-28T00:00:00.000Z"
}
developerId path parameters on management routes are also validated and return
the same envelope when malformed.

Supported Events
Event	Trigger
new_api_call	A developer's API is called
settlement_completed	A USDC revenue settlement completes after DB commit
low_balance_alert	Developer balance drops below threshold
usage_event.created	A usage event is recorded for an API call
Payload Schema
All events POST a JSON body with this structure:

JSON

{
  "event": "new_api_call",
  "timestamp": "2025-06-10T14:32:00.000Z",
  "developerId": "dev_abc123",
  "data": { ... }
}
new_api_call data
JSON

{
  "apiId": "api_xyz",
  "endpoint": "/translate",
  "method": "POST",
  "statusCode": 200,
  "latencyMs": 142,
  "creditsUsed": 1
}
settlement_completed data
JSON

{
  "settlementId": "settle_001",
  "amount": "25.5000000",
  "asset": "USDC",
  "txHash": "abc123...",
  "settledAt": "2025-06-10T14:30:00.000Z"
}
low_balance_alert data
JSON

{
  "currentBalance": "2.0000000",
  "thresholdBalance": "5.0000000",
  "asset": "XLM"
}
usage_event.created data
JSON

{
  "id": "ue_abc123",
  "requestId": "req_xyz789",
  "apiId": "api_456",
  "endpointId": "ep_789",
  "developerId": "dev_abc123",
  "amountUsdc": 25,
  "statusCode": 200,
  "timestamp": "2026-07-25T10:00:00.000Z"
}
Security
HTTPS Required (Production)
All webhook URLs must use https:// in production.

SSRF Protection
Internal/private IP addresses are blocked. The following ranges are rejected:
10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x, 169.254.x.x, etc.

Delivery headers (dispatchWebhook)
Outbound deliveries from src/webhooks/webhook.dispatcher.ts always set:

Header	Format	Always sent?	Description
Content-Type	application/json	Yes	JSON payload content type
User-Agent	Callora-Webhook/1.0	Yes	Identifies Callora as the sender
X-Callora-Event	event name string	Yes	Event type being delivered
X-Callora-Timestamp	ISO-8601 string	Yes	Copy of payload.timestamp (informational; not signed)
X-Callora-Delivery	UUID	Yes	Stable delivery id for the dispatch call (retries reuse the same value)
X-Request-Id	string	When present	Correlation id from the triggering request context
X-Correlation-Id	string	When present	Broader correlation id from request context
X-Callora-Signature	sha256=<hex>	Only when a secret is configured	HMAC-SHA256 of the raw body only
Unsigned deliveries: If the subscription was registered without a secret,
Callora does not send X-Callora-Signature. Receivers must treat the absence
of a signature as "no authenticity guarantee" and should reject such traffic in
production unless the endpoint is intentionally open.

Signature contract (source of truth)
Implemented by signPayload / dispatchWebhook in
src/webhooks/webhook.dispatcher.ts:

TypeScript

function signPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// body = JSON.stringify(payload)
headers['X-Callora-Signature'] = `sha256=${signPayload(config.secret, body)}`;
Exact rules receivers must follow:

Header name is X-Callora-Signature (not X-Callora-Signature-256, not
x-webhook-signature).
MAC input is the raw HTTP body bytes only — the exact bytes Callora POSTs
(JSON.stringify(payload)). Do not prepend the timestamp, nonce, delivery
id, or any other header value.
X-Callora-Timestamp is not covered by the signature. A captured body can
be replayed with a fresh timestamp header today; protect against that with
delivery-id idempotency (below). Timestamp binding is planned (see note).
Format is sha256= + lowercase hex of the HMAC-SHA256 digest (64 hex chars).
Compare using a constant-time equality over the hex digest (or over the full
sha256=<hex> header value). Never use === / == on untrusted input in a
way that short-circuits on the first differing byte if you can avoid it.
Why this matters
Docs that previously described X-Callora-Signature-256 over
<timestamp>.<nonce>.<rawBody> describe a different path used for Callora's
inbound deliver route (src/webhooks/webhook.signature.ts), not the signatures
Callora attaches when it POSTs to your endpoint. Verifying outbound deliveries
with that scheme will always fail — or worse, lead receivers to skip verification.

Verification samples
Always verify against the raw body your HTTP stack received, before JSON
parsing mutates whitespace or key order.

Node.js
JavaScript

import crypto from 'crypto';

/**
 * Verify an outbound Callora webhook delivery.
 * MAC input = raw body bytes only (matches dispatchWebhook / signPayload).
 */
function verifyCalloraSignature(secret, rawBody, signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const receivedHex = signatureHeader.slice('sha256='.length);
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBody) // Buffer or string of the exact POST body
    .digest('hex');

  if (receivedHex.length !== expectedHex.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(receivedHex, 'utf8'),
    Buffer.from(expectedHex, 'utf8'),
  );
}

// Express example — capture raw bytes before express.json():
// app.post('/webhooks/callora', express.raw({ type: 'application/json' }), (req, res) => {
//   const ok = verifyCalloraSignature(
//     process.env.CALLORA_WEBHOOK_SECRET,
//     req.body, // Buffer when using express.raw
//     req.get('X-Callora-Signature'),
//   );
//   if (!ok) return res.status(401).send('invalid signature');
//   // ... process JSON.parse(req.body.toString('utf8'))
// });
Python
Python

import hmac
import hashlib

def verify_callora_signature(secret: str, raw_body: bytes, signature_header: str) -> bool:
    """Verify an outbound Callora webhook. MAC input = raw body bytes only."""
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    received_hex = signature_header[len("sha256="):]
    expected_hex = hmac.new(
        secret.encode("utf-8"),
        raw_body,  # exact POST body bytes — do not include timestamp
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(received_hex, expected_hex)
Fixture check (matches dispatcher tests)
The integration fixtures assert the same contract:

TypeScript

const expectedSignature = crypto
  .createHmac('sha256', secret)
  .update(JSON.stringify(payload)) // raw body only
  .digest('hex');
// header value: `sha256=${expectedSignature}`
Validate locally:

Bash

npm test -- src/webhooks/webhook.dispatcher.test.ts
npm test -- tests/integration/webhooks.test.ts
npm test -- src/webhooks/webhook.signature.test.ts
Replay protection with X-Callora-Delivery
Because the timestamp is not part of the MAC today, signature verification
alone does not stop replay of a captured request body. Use the delivery id:

Read X-Callora-Delivery (UUID assigned once per dispatchWebhook call).
Persist the id (or a hash of it) when you accept a delivery.
If the same id is seen again, return 2xx without re-applying side effects
(Callora retries failed deliveries with the same X-Callora-Delivery).
Optionally retain ids for longer than your retry window so delayed retries
remain idempotent.
Do not key idempotency only on X-Callora-Timestamp — it is unsigned and
shared across logical events that happen to carry the same payload timestamp.

Signing secret rotation
Rotate a webhook signing secret with:

http

POST /api/webhooks/:developerId/rotate-secret
The response includes the new secret exactly once:

JSON

{
  "message": "Webhook secret rotated successfully.",
  "developerId": "dev_abc123",
  "secret": "new-secret-value",
  "previous_expires_at": "2026-06-26T12:00:00.000Z"
}
Grace window behaviour (WebhookStore.rotateSecret /
WebhookStore.getActiveSecrets):

Moment	Active secrets used for verification
Before rotation	secret_current only
After rotation, before previous_expires_at	secret_current and secret_previous
At/after previous_expires_at	secret_current only (secret_previous is dropped)
Second rotation during grace	Former current becomes previous; older previous is discarded
Store the returned secret immediately — it is never shown again.
Keep accepting signatures from both the new secret and the previous secret
until previous_expires_at.
After that instant, reject the previous secret.
Grace duration is WEBHOOK_SECRET_ROTATION_GRACE_MS (default 24 hours =
24 * 60 * 60 * 1000).
Failure responses must not reveal which key matched.
During rotation, try each active secret with constant-time comparison and accept
if any matches (order must not leak via timing).

Planned: timestamp signing
Forward-looking note: Callora plans to bind X-Callora-Timestamp (and
possibly a nonce) into the HMAC so receivers can reject stale deliveries
cryptographically. Today's contract is raw-body-only via
X-Callora-Signature. Until that ships, rely on X-Callora-Delivery
idempotency for replay defense, and treat X-Callora-Timestamp as advisory
metadata only. A future change will be versioned and documented here before
receivers are required to adopt it.

Inbound deliver route (platform-internal)
POST /api/webhooks/deliver/:developerId uses a separate scheme
(X-Callora-Signature-256 over <timestamp>.<nonce>.<rawBody> with nonce
replay checks in src/webhooks/webhook.signature.ts). That path authenticates
traffic into Callora. Third-party endpoints that receive Callora events
must implement the outbound contract above, not the inbound one.

Retry Policy
Failed deliveries (non-2xx, timeout, DNS failure) are retried with exponential backoff:

Attempt	Delay
1	1s
2	2s
3	4s
4	8s
5	16s
After 5 failures, the event is dropped and logged server-side.

Override retry behavior for a single subscription with:

http

PATCH /api/webhooks/:developerId/retry-policy
Content-Type: application/json
JSON

{
  "retryPolicy": {
    "maxRetries": 3,
    "baseDelayMs": 500
  }
}
retryPolicy is optional; sending {} clears the override. When provided,
maxRetries must be an integer from 0 to 10 and baseDelayMs must be an
integer from 100 to 60000.

Manage Webhooks
Method	Endpoint	Description
POST	/api/webhooks	Register webhook
GET	/api/webhooks/:developerId	View current webhook
POST	/api/webhooks/:developerId/rotate-secret	Rotate signing secret
PATCH	/api/webhooks/:developerId/retry-policy	Update retry policy
DELETE	/api/webhooks/:developerId	Remove webhook
Rate Limiting
The webhook management endpoints (POST /, GET /:developerId, DELETE /:developerId) are
protected by an IP-based rate limiter. The signed inbound delivery route
(POST /deliver/:developerId) is not rate-limited here because it is
protected independently by HMAC signature verification.

Env variable	Default (fallback)	Description
WEBHOOK_RATE_LIMIT_WINDOW_MS	REST_RATE_LIMIT_WINDOW_MS (60 000)	Window length in milliseconds
WEBHOOK_RATE_LIMIT_MAX_REQUESTS	REST_RATE_LIMIT_MAX_REQUESTS (100)	Max requests per IP per window
When the limit is exceeded, the server responds with HTTP 429 and a
Retry-After header indicating how many seconds to wait before retrying.

Webhook Subsystem Health Probe
GET /api/webhooks/health

Returns an at-a-glance operational snapshot of the webhook subsystem. The
endpoint is read-only and requires no authentication, making it safe to use
with load-balancer health checks and uptime monitors.

Status semantics
Status	HTTP code	Meaning
"ok"	200	DLQ is empty; no recent delivery failures.
"degraded"	200	One or more recent delivery failures, but DLQ depth is below the warning threshold (10). The subsystem is functional.
"down"	503	DLQ depth has reached or exceeded 10, indicating a systemic delivery problem.
Response shape
JSON

{
  "status": "ok",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "webhooks": {
    "registeredCount": 3,
    "dlqDepth": 0,
    "recentFailures": []
  }
}
webhooks object
Field	Type	Description
registeredCount	number	Total active webhook subscriptions.
dlqDepth	number	Current entries in the dead-letter queue.
recentFailures	array	Up to 20 most-recent failed delivery attempts, newest first.
recentFailures entry
Field	Type	Description
deliveryId	string	Unique ID assigned to the delivery attempt.
developerId	string	Developer whose subscription triggered the delivery.
event	string	Webhook event type that was being delivered.
url	string	Target URL that was called (registered by the developer).
failedAt	string	ISO-8601 timestamp of the final failure.
lastError	string	Human-readable, non-sensitive last error description.
attempts	number	Total delivery attempts made before giving up.
Security note: Webhook secrets are never included in this response.
Only non-sensitive operational metadata is returned.

Example responses
All healthy:

JSON

{
  "status": "ok",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "webhooks": {
    "registeredCount": 3,
    "dlqDepth": 0,
    "recentFailures": []
  }
}
Degraded (recent failures, DLQ not full):

JSON

{
  "status": "degraded",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "webhooks": {
    "registeredCount": 3,
    "dlqDepth": 2,
    "recentFailures": [
      {
        "deliveryId": "abc123",
        "developerId": "dev_001",
        "event": "settlement_completed",
        "url": "https://example.com/hook",
        "failedAt": "2026-07-26T11:59:00.000Z",
        "lastError": "HTTP 503 Service Unavailable",
        "attempts": 5
      }
    ]
  }
}
Down (DLQ at or above threshold of 10):

http

HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "status": "down",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "webhooks": {
    "registeredCount": 3,
    "dlqDepth": 10,
    "recentFailures": [ ... ]
  }
}