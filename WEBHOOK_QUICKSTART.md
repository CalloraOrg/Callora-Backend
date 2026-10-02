Webhook quick start
This guide has been consolidated into the canonical webhook documentation.

Start here: docs/webhooks.md

Receiver checklist
Register with a secret (POST /api/webhooks) so deliveries are signed.
Read X-Callora-Signature (sha256=<hex>).
Compute HMAC-SHA256 over the raw body only — do not include
X-Callora-Timestamp or any other header in the MAC.
Compare with a constant-time equality helper.
Deduplicate on X-Callora-Delivery (retries reuse the same id).
On secret rotation, honour previous_expires_at and accept both secrets
during the grace window.
Full header table, Node/Python samples, rotation behaviour, and the note on
planned timestamp signing live in docs/webhooks.md.

Bash

# Dispatcher header + signature fixtures
npm test -- src/webhooks/webhook.dispatcher.test.ts
npm test -- tests/integration/webhooks.test.ts

# Inbound deliver-route signature helpers (platform-internal)
npm test -- src/webhooks/webhook.signature.test.ts