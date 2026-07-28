# API Listings Conditional GET (ETag / 304)

`GET /api/apis` supports **conditional GET** via strong ETags so marketplace clients and crawlers can poll listings without re-downloading an unchanged payload.

## Behaviour

1. A successful `200` listings response includes a strong `ETag` header:
   - Format: `"<64-char-sha256-hex>"` (quoted, no `W/` prefix)
   - Digested over the exact JSON body returned to the client (including pagination `meta`)
2. On a later request, clients may send:
   ```http
   If-None-Match: "<etag-from-previous-response>"
   ```
3. If the listing body is unchanged, the server responds with:
   - Status: `304 Not Modified`
   - Body: empty
   - `ETag` header retained for the same validator
4. If the body changed (new APIs, different filters/pagination, cache refresh with new data), the server returns `200` with a fresh body and a new `ETag`.

Comparison uses **RFC 7232 strong comparison**:

- `*` matches any current representation
- Weak client tags (`W/"…"`) never match a strong server tag
- Multiple comma-separated tags are evaluated left-to-right

## Example

```bash
# Initial fetch
curl -i 'http://localhost:3000/api/apis?limit=20&offset=0'
# ← 200 OK
# ← ETag: "a1b2…64hex…"
# ← {"data":[…],"meta":{…}}

# Conditional revalidation (unchanged)
curl -i 'http://localhost:3000/api/apis?limit=20&offset=0' \
  -H 'If-None-Match: "a1b2…64hex…"'
# ← 304 Not Modified (empty body)

# Different query → different representation → different ETag
curl -i 'http://localhost:3000/api/apis?category=weather'
```

## Notes

- ETag support is mounted only on the public listings route (`GET /api/apis`), not on `GET /api/apis/:id` or mutation endpoints.
- Server-side TTL listings cache and ETag validation are complementary: the cache reduces DB load; ETags reduce bandwidth on the wire when clients already hold a fresh copy.
- Rate limiting still applies to conditional requests (a 304 still counts toward the listings rate limit).

## Related code

- Middleware: `src/middleware/etag.ts`
- Route wiring: `src/routes/apis.ts`
