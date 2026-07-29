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
- `accept-encoding` - Preferred content encodings
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
- Unique `x-request-id` headers enable end-to-end request tracing
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
