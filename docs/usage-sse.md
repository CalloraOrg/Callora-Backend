# Usage SSE stream

## Overview

The backend now exposes an authenticated Server-Sent Events endpoint at `/api/usage/sse` for live developer dashboard updates.

## Behavior

- The stream uses `Content-Type: text/event-stream` and keeps the connection open while the client remains connected.
- The server sends an initial `connected` event immediately after the handshake succeeds.
- Each new usage event recorded for the authenticated user is emitted as an SSE `usage` event with the event payload.
- Clients should reconnect on disconnects; the backend will clean up the subscription automatically.

## Authentication

The endpoint accepts the same authentication mechanisms as the rest of the usage API:

- `x-user-id` header, or
- a bearer JWT via the standard `Authorization` header.

## Example

```bash
curl -N -H 'x-user-id: user-123' http://localhost:3000/api/usage/sse
```

## Notes

The SSE endpoint is intended for developer dashboards that need real-time usage feedback without polling the REST usage endpoints.
