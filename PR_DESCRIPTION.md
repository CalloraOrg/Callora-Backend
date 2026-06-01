# task: enforce unique active api_key prefixes

## Summary

The gateway auth flow in `src/middleware/gatewayApiKeyAuth.ts` performs a
prefix-based lookup before a timing-safe full-key hash comparison.  Without a
database-level guarantee, two active keys could share the same prefix, making
the lookup ambiguous and potentially allowing one key to shadow another.

This PR adds the missing constraint and its regression tests.

---

## Changes

### `migrations/0006_api_key_prefix_unique.sql` (new)
Adds a **partial unique index** on `api_keys (prefix) WHERE revoked = FALSE`.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_prefix_active
  ON api_keys (prefix)
  WHERE revoked = FALSE;
```

- Active keys are guaranteed to have unique prefixes at the database level.
- Revoked keys are excluded so a prefix can be reused after revocation.

### `migrations/0006_api_key_prefix_unique.down.sql` (new)
Rollback: `DROP INDEX IF EXISTS uq_api_keys_prefix_active;`

### `src/repositories/apiKeyRepository.prefix.test.ts` (new)
Constraint regression tests using **pg-mem** (no external DB required):

| Test | Covers |
|------|--------|
| Allows unique active prefix | Happy path |
| Allows two active keys with different prefixes | Happy path |
| Rejects duplicate active prefix | Collision — acceptance criterion 1 |
| Rejects duplicate prefix for different `api_id` | Collision variant |
| Allows prefix reuse after revocation | Revocation — acceptance criterion 2 |
| Allows multiple revoked keys with same prefix | Revocation variant |
| Does not block new active key when revoked key exists | Revocation — acceptance criterion 3 |
| Allows multiple NULL-prefix rows | Documents NULL semantics |
| Prefix lookup returns exactly one row | Mirrors gateway middleware query |
| Prefix lookup returns zero rows after revocation | Mirrors gateway middleware query |

### `tests/helpers/db.ts` (updated)
Added `prefix VARCHAR(16)` column and the partial unique index to the shared
pg-mem schema used by integration tests, keeping it in sync with the real
PostgreSQL schema.

### `docs/gateway-api-key-auth.md` (updated)
Added a **Prefix uniqueness guarantee** section documenting the new index and
pointing to the regression tests.

### `migrations/README.md` (updated)
Added migration 0006 to the table.

---

## Acceptance criteria

- [x] Inserting a duplicate active prefix fails at the database level
- [x] Revoked keys do not block reuse of a prefix
- [x] Tests cover collision and revocation cases

---

## Testing

Tests run with Jest + pg-mem (no external PostgreSQL required):

```bash
npm test -- --testPathPattern="apiKeyRepository.prefix.test"
```

All 10 constraint regression tests pass.

---

closes #309
