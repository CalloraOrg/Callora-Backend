Webhook signature verification
This document has been consolidated.

Canonical guide: docs/webhooks.md

Outbound Callora deliveries (dispatchWebhook) use:

Header: X-Callora-Signature: sha256=<hex>
MAC input: raw HTTP body bytes only (timestamp is not signed)
No signature header when the subscription has no secret
Do not use the older X-Callora-Signature-256 / <timestamp>.<nonce>.<rawBody>
examples from previous revisions of this file for verifying events Callora
sends to your endpoint — that scheme is the platform-inbound deliver route only.

See Signature contract, Verification samples (Node + Python),
Replay protection with X-Callora-Delivery, and Signing secret rotation
in docs/webhooks.md.