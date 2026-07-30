# ETag / 304 Caching — GET /api/apis

**Issue:** #866  
**Added in:** `src/middleware/etagCache.ts`, `src/routes/apis.ts`

## Overview

`GET /api/apis` and `GET /api/apis/:id` support HTTP conditional requests via
strong ETags and `304 Not Modified` responses. Clients that cache the response
can supply an `If-None-Match` header on subsequent requests; when the response
content has not changed, the server replies with `304` and an empty body,
saving bandwidth and client-side parsing time.

## How It Works

1. On every successful `GET /api/apis` or `GET /api/apis/:id` response, the
   server serialises the response body to JSON, computes a 32-character
   SHA-256 hex digest, and emits it as a strong `ETag` header:

   ```
   ETag: "a7ffc6f8bf1ed76651c14756a061d662"
   ```

2. The client stores the ETag alongside the cached response body.

3. On the next request, the client sends the stored ETag in `If-None-Match`:

   ```
   GET /api/apis HTTP/1.1
   If-None-Match: "a7ffc6f8bf1ed76651c14756a061d662"
   ```

4. If the current response body would hash to the same digest, the server
   returns `304 Not Modified` with an empty body (saving the transfer cost of
   the JSON payload).

5. If the data has changed (new APIs added, existing ones updated), the hash
   differs and the server returns the full `200` response with the updated body
   and the new ETag.

## Routes Covered

| Route | ETag? | Notes |
|---|---|---|
| `GET /api/apis` | ✅ | Covers all query params (limit, offset, category, search). Different params → different ETags. |
| `GET /api/apis/:id` | ✅ | Per-resource ETag, includes endpoint list in the hash. |
| `POST /api/apis` | ❌ | Write operation — no caching. |
| `POST /api/apis/:id/endpoints/bulk` | ❌ | Write operation — no caching. |

## Response Headers

| Header | Example | Description |
|---|---|---|
| `ETag` | `"a7ffc6f8bf1ed76651c14756a061d662"` | Strong ETag. Always present on 200 responses from the covered GET routes. |

## Request Headers

| Header | Example | Description |
|---|---|---|
| `If-None-Match` | `"a7ffc6f8bf1ed76651c14756a061d662"` | Single ETag, comma-separated list, weak ETag (`W/"..."`), or wildcard (`*`). |

## ETag Format

ETags are **strong** (no `W/` prefix). The value is the first 32 hex characters
of the SHA-256 digest of the JSON-serialized response body, wrapped in
double-quotes.

- **Strong** because the digest changes if and only if the response bytes
  change — precise byte-level equivalence, not just semantic equivalence.
- **Body-derived** (not timestamp- or version-derived) so two requests that
  return the same data always produce the same ETag, regardless of when they
  are made.

## Express Built-in ETag

Express 4.x generates **weak** ETags by default (`app.set('etag', 'weak')` is
the implicit default). The Callora backend does **not** disable Express's
default ETag generation globally, because that would affect all other routes.

Instead, `apis.ts` sets the `ETag` header explicitly before calling
`res.json()`. When an `ETag` header is already present at response finalisation
time, Express skips its own ETag generation for that response.

## Interaction with the ListingsCache

`GET /api/apis` already uses an in-process `ListingsCache` (30-second TTL by
default) to skip DB reads on repeated requests. ETag evaluation happens on top
of this layer:

- **Cache hit + matching ETag:** Both the DB read *and* the HTTP body transfer
  are skipped. This is the fully-optimised path.
- **Cache hit + stale/absent ETag:** The DB read is skipped (ListingsCache
  hit), but the full 200 body is returned.
- **Cache miss + matching ETag:** The DB read happens (cache miss), the
  response is built, the ETag is computed, and the 304 shortcut is applied.
  The body transfer is saved even on cache misses with a warm client.

## Example with curl

**First request — get the ETag:**

```bash
curl -si https://api.callora.io/api/apis | grep -E '^(HTTP|etag|ETag)'
```

```
HTTP/2 200
etag: "a7ffc6f8bf1ed76651c14756a061d662"
```

**Subsequent request — 304 when data is unchanged:**

```bash
curl -si https://api.callora.io/api/apis \
  -H 'If-None-Match: "a7ffc6f8bf1ed76651c14756a061d662"'
```

```
HTTP/2 304
etag: "a7ffc6f8bf1ed76651c14756a061d662"
```

**Subsequent request — 200 when data has changed:**

```bash
curl -si https://api.callora.io/api/apis \
  -H 'If-None-Match: "a7ffc6f8bf1ed76651c14756a061d662"'
```

```
HTTP/2 200
etag: "b3d2ae19f7c4e0a5d8f92c6b1e4a8305"
content-type: application/json; charset=utf-8

{"data":[...],"meta":{...}}
```

## Implementation Notes

The ETag computation uses the **compute-then-compare** approach: the route
builds the full response object before computing the ETag and issuing a 304.
For `GET /api/apis`, skipping the full response build on 304 would require
restructuring the cache layer significantly. Given that the ListingsCache
already skips the DB on cache hits, and that `JSON.stringify` + SHA-256 on a
20-item listing is sub-millisecond, the compute-then-compare cost is
negligible.

The implementation is in `src/middleware/etagCache.ts` and exports three pure
functions: `computeStrongETag`, `parseIfNoneMatch`, and `isETagMatch`. No new
npm dependencies were introduced — only Node.js's built-in `node:crypto` module
is used.
