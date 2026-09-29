# Forwarded Header Policy

## Overview

This document outlines the Callora Backend proxy's header forwarding policy to ensure security and proper request routing while preventing sensitive information leakage.

## Client IP Resolution

When a request arrives at the service, the client IP is resolved by
`src/lib/clientIp.ts`. The behaviour is governed by the `TRUST_PROXY_HEADERS`
environment variable, which accepts:

-  `false` (default) — no proxy hop is trusted. The direct socket
    address (req.ip / req.socket.remoteAddress) is used and all
    forwarded headers are ignored.
-   `true` — alias for a single trusted proxy hop.
-   a non-negative integer N — the number of trusted reverse proxy
    hops between the client and the service.

When N > 0, the client IP is taken from the entry N positions from the
right of the `X-Forwarded-For` chain (matching Express `trust proxy`
semantics). The leftmost entry is client-controlled and must never be
trusted when any proxy hop is configured. If the chain is shorter than N,
or the selected entry is not a valid IP, resolution falls back to the
socket address.

For example, with one trusted hop and `X-Forwarded-For: 1.1.1.1, 2.2.2.2`,
the resolved client IP will be `2.2.2.2`.

## Security Headers (Stripped Before Forwarding)

The following headers are **never** forwarded to upstream services for security and privacy reasons:

### Authentication & Authorization
- `x-api-key` - API authentication key
- `authorization` - Bearer tokens and other authorization schemes
- `proxy-authorization` - Proxy authentication credentials
- `cookie` - HTTP cookies containing session data

### Network Infrastructure
- `host` - The original request host
- `x-forwarded-for` - Client IP address chain
- `x-real-ip` - Original client IP address
- `connection` - Connection control directives
- `keep-alive` - Persistent connection directives
- `transfer-encoding` - Transfer encoding specifications
- `te` - Transfer encoding (legacy)
- `trailer` - Trailer header fields
- `upgrade` - Protocol upgrade directives
- `proxy-connection` - Proxy connection directives

## Headers Added by Proxy

The proxy adds the following headers to all upstream requests:

- `x-request-id` - Unique UUIT v4 identifier for request tracing and correlation

## Safe Headers (Forwarded)

All other headers not in the strip list are forwarded to upstream services, including but not limited to:

- `content-type` - Media type of the request body
- `content-length` - Length of the request body
- `accept` - Preferred response media types
- `user-agent` - Client software identification
- `accept-encoding` - Preferred response encodings
- `accept-language` - Preferred response languages
- Custom application headers (e.g., `x-custom-*`)

## Response Header Handling

### Headers Preserved from Upstream
All upstream response headers are forwarded to the client **except** hop-by-hop headers:

- `connection`
- `keep-alive`
- `transfer-encoding`
- `te`
- `trailer`
- `upgrade`

### Headers Overridden by Proxy
- `x-request-id` - Always set to the proxy's request ID for correlation

## Case Sensitivity

Header stripping is performed case-insensitively. All header name variations (e.g., `X-API-Key`, `x-api-key`, `X-API-KEY`) are treated identically.

## Security Considerations

### Preventing Information Leakage
- API keys and authentication tokens are stripped to prevent credential leakage
- Network infrastructure headers are stripped to prevent IP address exposure
- Cookie headers are stripped to prevent session hijacking

### Request Tracing
- Unique `x-request-id` Headers enable end-to-end request tracing
- Request IDs are included in error responses for debugging
- UUID v4 format ensures global uniqueness

## Implementation Details

The header policy is implemented in `src/routes/proxyRoutes.ts`:

```typescript
const DEFAULT_STRIP_HEADERS = [
  'host',
  'x-api-key',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
];

```

Headers are processed case-insensitively using lowercase comparison:

```typescript
const stripSet = new Set(config.stripHeaders.map((h) => h.toLowerCase()));
for (const [key, value] of Object.entries(req.headers)) {
  if (!stripSet.has(key.toLowerCase()) && typeof value === 'string') {
    forwardHeaders[key] = value;
  }
}
```

## Testing

Comprehensive tests verify:
- Sensitive headers are stripped from upstream requests
- Safe headers are forwarded correctly
- Case-insensitive header stripping works
- Response headers are filtered appropriately
- Request ID correlation is maintained

See `src/__tests__/proxy.integration.test.ts` for detailed test coverage.
