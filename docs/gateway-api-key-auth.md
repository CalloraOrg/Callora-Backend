# Gateway API Key Authentication

Gateway routes that proxy upstream APIs now use a dedicated API key authentication middleware.

## Supported headers

The middleware accepts either of these request formats:

```http
Authorization: Bearer <api_key>
```

```http
X-Api-Key: <api_key>
```

If both are present, a valid bearer token is preferred. A malformed `Authorization` header returns `401`.

## Validation flow

For each gateway request, the middleware:

1. Extracts the presented API key from `Authorization` or `X-Api-Key`.
2. Derives the key prefix from the first 16 characters.
3. Looks up candidate key records by prefix.
4. Verifies the full key using a timing-safe hash comparison.
5. Rejects revoked keys with `401 Unauthorized`.
6. Resolves and attaches:
   - `req.user`
   - `req.vault`
   - `req.api`
   - `req.endpoint`
   - `req.apiKeyRecord`
   - `req.apiKeyValue`

Rate limiting and balance checks remain separate middleware or route concerns and run after authentication.

## Failure responses

The middleware returns clear `401` responses for common auth failures:

- `Unauthorized: missing API key`
- `Unauthorized: malformed Authorization header`
- `Unauthorized: API key not found`
- `Unauthorized: invalid API key`
- `Unauthorized: API key has been revoked`
- `Unauthorized: API key does not grant access to this API`

If the target API cannot be resolved, it returns:

- `404 Not Found: unknown API`

## Route usage

The middleware is applied to the upstream proxy routes in:

- `src/routes/gatewayRoutes.ts`
- `src/routes/proxyRoutes.ts`

The route handlers then consume the attached request context instead of re-validating headers inline.

## Database notes

The database-backed middleware supports:

- prefix lookup from `api_keys.prefix`
- full-key hash verification against `api_keys.key_hash`
- revoked-key enforcement from `api_keys.revoked`
- eager loading of related `users` and `vaults`

To support revocation in environments that do not yet have the column, apply:

- `migrations/0005_add_api_key_revocation.sql`

### Prefix uniqueness guarantee

Migration `0006_api_key_prefix_unique.sql` adds a **partial unique index** on
`api_keys (prefix) WHERE revoked = FALSE`.  This guarantees that the
prefix-based lookup in step 3 of the validation flow always returns at most one
active candidate, eliminating any ambiguity before the full hash comparison.

Revoked keys are excluded from the index so a prefix can be legitimately reused
after a key is revoked (e.g. after rotation).

Constraint regression tests live in:
`src/repositories/apiKeyRepository.prefix.test.ts`
