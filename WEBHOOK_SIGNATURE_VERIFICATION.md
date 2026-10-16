Webhook signature verification
This document has been consolidated.

Canonical guide: docs/webhooks.md

Outbound Callora deliveries (dispatchWebhook) use:

Header: X-Callora-Signature: sha256=<hex>
Key ID header: X-Callora-Key-Id: <uuid> (identifies the active managed signing key from WebhookSignerService, or subscription id fallback)
MAC input: raw HTTP body bytes only (timestamp is not signed)
Automatic secret provisioning: Registering a webhook via POST /api/webhooks without a secret automatically generates a 64-hex-char signing secret, returns it once in the 201 response body, and signs all subsequent deliveries with X-Callora-Signature. Caller-supplied secrets shorter than 32 characters are rejected with HTTP 400.
Managed rotation: When platform signing keys are rotated via POST /api/admin/webhooks/rotate-key, new outbound deliveries immediately sign with the new active key and emit its id in X-Callora-Key-Id, while the previous key remains valid for verification during the configured grace window (WEBHOOK_SECRET_ROTATION_GRACE_MS).
No signature header when neither a managed active key nor a subscription secret is configured
Do not use the older X-Callora-Signature-256 / <timestamp>.<nonce>.<rawBody>
examples from previous revisions of this file for verifying events Callora
sends to your endpoint — that scheme is the platform-inbound deliver route only.

See Signature contract, Verification samples (Node + Python),
Replay protection with X-Callora-Delivery, and Signing secret rotation
in docs/webhooks.md.