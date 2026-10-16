# Usage SSE stream

## Overview

The backend now exposes an authenticated Server-Sent Events endpoint at `/api/usage/sse` for live developer dashboard updates.

## Behavior

- The stream uses `Content-Type: text/event-stream` and keeps the connection open while the client remains connected.
- The server sends a `retry:` directive (default `3000` ms) and an initial `connected` event immediately after the handshake succeeds.
- Periodic `: ping` heartbeat comments are sent (default every `20000` ms, configurable via `USAGE_SSE_HEARTBEAT_INTERVAL_MS`) to keep idle connections alive through reverse proxies and load balancers.
- Concurrent streams per user are capped (default `5`, configurable via `USAGE_SSE_MAX_CONNECTIONS_PER_USER`); opening additional streams beyond the cap returns `429 Too Many Requests`.
- Reconnecting clients that send a `Last-Event-ID` header automatically receive buffered events emitted after that event ID in chronological order (bounded per-user ring buffer, configurable via `USAGE_SSE_BUFFER_SIZE`).
- Active SSE connections are tracked via the `usage_sse_active_connections` Prometheus gauge.
- Each new usage event recorded for the authenticated user is emitted as an SSE `usage` event with the event payload.
- Clients should reconnect on disconnects; the backend will clean up the subscription and heartbeat timer automatically.

## Authentication

The endpoint accepts the same authentication mechanisms as the rest of the usage API:

- `x-user-id` header (when forwarded auth is enabled), or
- a bearer JWT via the standard `Authorization` header.

## Example

```bash
curl -N -H 'x-user-id: user-123' -H 'Last-Event-ID: evt-1' http://localhost:3000/api/usage/sse
```

## Notes

The SSE endpoint is intended for developer dashboards that need real-time usage feedback without polling the REST usage endpoints.
