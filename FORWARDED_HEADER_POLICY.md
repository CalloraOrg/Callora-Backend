# Forwarded Header Policy

## Overview

This document outlines the Callora Backend proxy's header forwarding policy to ensure security and proper request routing while preventing sensitive information leakage.

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

- `x-request-id` - Unique UUID v4 identifier for request tracing and correlation

## Safe Headers (Forwarded)

All other headers not in the strip list are forwarded to upstream services, including but not limited to:

- `content-type` - Media type of the request body
- `content-length` - Length of the request body
- `accept` - Preferred response media types
- `user-agent` - Client software identification
- `accept-encoding` - Preferred response encodings
- `accept-language` - Preferred response languages
- Custom application headers (e.g. `x-custom-*`)

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

Header stripping is performed case-insensitively. All header name variations (e.g. `X-API-Key`, `x-api-key`, `X-API-KEY`) are treated identically.

## Security Considerations

### Preventing Information Leakage
- API keys and authentication tokens are stripped to prevent credential leakage
- Network infrastructure headers are stripped to prevent IP address exposure
- Cookie headers are stripped to prevent session hijacking

### Request Tracing
- Unique `x-request-id` Headers enable end-to-end request tracing
- Request IDs are included in error responses for debugging
- UUID v4 format ensures global uniqueness

## Trusted Proxy Hops and Client IP Resolution

When the service sits behind one or more reverse proxies, the client IP used for the admin IP-allowlist and per-IP rate limiting is resolved by `src/lib/clientIp.ts`.

The client-controlled leftmost entry of `X-Forwarded-For` is never used unless the entire chain is trusted. The configuration is controlled by the `TRUST_PROXY_HEADERS` environment variable:

| Value | Meaning |
| --- | --- |
| unset / `false` | No proxy headers are trusted; the direct socket address is used. |
| `number` | Number of trusted proxy hops between the client and the app. The client IP is taken that many positions from the right of the forwarded chain. |
| `true` | Backwards-compatible alias for a single trusted hop (`1 `). |
| `CIDR,CIDR,`| Comma-separated trusted proxy CIDRs. The chain is walked from the right, skipping addresses inside the trusted ranges. |

Examples (with one trusted hop):

- `X-Forwarded-For: 1.1.1.1, 2.2.2.2` → client IP is `2.2.2.2`.
- `X-Forwarded-For: 9.9.9.9, 2.2.2.2` → client IP is `2.2.2.2` (the spoofed leftmost entry is ignored).

This aligns with Express's `trust proxy` semantics.

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
