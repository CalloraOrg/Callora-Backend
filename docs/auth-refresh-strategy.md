# Authentication Refresh Token Strategy

## Overview

This document outlines the refresh token strategy implemented in the Callora Backend to enhance security and improve user experience by allowing long-lived sessions without compromising security.

## Architecture

### Token Types

1. **Access Token** (JWT)
   - Short-lived (15 minutes default)
   - Contains user ID and optional wallet address
   - Used for API authentication
   - Cannot be revoked (expires naturally)

2. **Refresh Token** (JWT)
   - Long-lived (7 days default)
   - Contains user ID and unique token ID
   - Stored securely in database with SHA-256 hash
   - Can be revoked immediately
   - Used to obtain new access tokens

### Security Features

- **Token Hashing**: Refresh tokens are stored as SHA-256 hashes in the database
- **Atomic Single-Use Rotation**: Each refresh is a single conditional UPDATE on the primary database — no replica reads in the consume path
- **Family-based Theft Detection**: Token families span the entire rotation lineage; reuse of any member revokes all tokens for the user
- **Revocation Support**: Refresh tokens can be revoked individually or all at once
- **Rate Limiting**: Token usage is tracked with timestamps
- **Secure Verification**: Multiple layers of token validation

---

## Atomic Rotation (CAS)

### The Problem with Non-atomic Rotation

Before this change the refresh flow had three separate steps:
1. Read the stored token record (could go to a replica)
2. Check `isRevoked`, expiry, and hash
3. `UPDATE … SET is_revoked = true` (unconditional, no `AND is_revoked = false`)

**Race condition:** Two concurrent requests with the same token both pass step 2 before either completes step 3. Both receive a fresh token pair in the same family. Single-use rotation is defeated and theft is undetectable.

**Replica lag:** With `REPLICA_URLS` configured, step 1 could read from a replica. A token revoked moments ago on the primary still looks valid to a stale replica.

### The Fix: Compare-and-Set on the Primary

The entire rotation — consume + insert — is now a single primary-side transaction:

```sql
-- Step 1: Atomic consume (one row returned = won the CAS; zero rows = lost)
UPDATE refresh_tokens
SET    is_revoked = true,
       last_used_at = NOW()
WHERE  id         = $1           -- from JWT payload
  AND  user_id    = $2           -- from JWT payload
  AND  token_hash = $3           -- SHA-256(rawToken) — hash equality, not timing-safe
  AND  is_revoked = false        -- guard: only one winner
  AND  expires_at > NOW()        -- guard: not expired
RETURNING *;

-- Step 2 (same transaction): Insert the new token
INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at,
                            last_used_at, is_revoked, family_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
```

When the UPDATE returns zero rows the method re-reads on the **primary** to classify the failure:

| Re-read outcome | Returned status | Controller error code |
|---|---|---|
| Row missing | `not_found` | `INVALID_REFRESH_TOKEN` |
| `is_revoked = true` | `revoked` → triggers `handleReuse` | `REVOKED_TOKEN` |
| `expires_at ≤ NOW` | `expired` | `EXPIRED_TOKEN` |
| Hash mismatch | `hash_mismatch` | `INVALID_REFRESH_TOKEN` |

**Exactly one winner.** For N concurrent requests with the same token, the PostgreSQL row-level lock on the UPDATE ensures exactly one UPDATE succeeds. All others receive `'revoked'`, triggering `handleReuse` which revokes the entire family.

### Double-submit Policy

A legitimate network retry that re-sends the original refresh token after the first request succeeded will also land on `'revoked'` (the token was already consumed). The entire family is revoked and the user must re-authenticate.

This is the intentional policy, aligned with common OAuth 2.0 guidance: the window for an undetected theft is eliminated at the cost of requiring re-authentication on a genuine retry. Clients should implement idempotency via the `Idempotency-Key` header to avoid triggering this on retries.

### No Replica Reads in the Consume Path

`consumeRefreshToken` acquires a dedicated client from the primary pool (`pool.connect()`) and runs both the UPDATE and the INSERT in a single `BEGIN … COMMIT` block. `REPLICA_URLS`, if set, is never consulted for refresh-token security decisions.

The secondary re-read (to classify failures) also uses the same dedicated primary client within the transaction context before `ROLLBACK`.

---

## Implementation Details

### Database Schema

```sql
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    family_id UUID NOT NULL,
    INDEX idx_refresh_tokens_user_id (user_id),
    INDEX idx_refresh_tokens_expires_at (expires_at),
    INDEX idx_refresh_tokens_hash (token_hash)
);
```

### Family Propagation

The `family_id` is **not** passed by the service to `consumeRefreshToken`. The repository reads it from the consumed row's `RETURNING *` and writes it into the new token automatically. This ensures the family chain is maintained by the repository layer with no risk of the service passing an incorrect family.

### API Endpoints

#### POST /auth/refresh
Refresh an access token using a valid refresh token.

**Request:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiJ9..."
}
```

**Response (success):**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiJ9...",
  "tokenType": "Bearer"
}
```

**Error codes:**

| Code | HTTP | Condition |
|---|---|---|
| `MISSING_REFRESH_TOKEN` | 400 | Body field absent |
| `INVALID_REFRESH_TOKEN` | 401 | JWT invalid / not_found / hash_mismatch |
| `EXPIRED_TOKEN` | 401 | Token exists but expired |
| `REVOKED_TOKEN` | 401 | Token already consumed (theft signal; all tokens revoked) |
| `REFRESH_FAILED` | 401 | Unexpected server error |

#### POST /auth/revoke
Revoke a specific refresh token.

#### POST /auth/revoke-all
Revoke all refresh tokens for the authenticated user.

#### GET /auth/tokens
Get information about active tokens for the authenticated user.

---

## Security Considerations

### Hash Comparison

The `token_hash` comparison in the SQL `WHERE` clause uses standard SQL string equality, not a timing-safe comparison. This is acceptable because:
1. The hash itself is a SHA-256 digest — not a direct secret.
2. The token ID (`id`) is already verified by the JWT signature before the SQL query runs.
3. The SQL comparison does not leak information through timing in the same way a string comparison in application code would.

The JavaScript `verifyTokenHash` method (used for the explicit hash verification in non-atomic paths) retains `crypto.timingSafeEqual`.

### Token Storage
- Refresh tokens must be stored securely on the client (e.g., httpOnly cookies, secure storage)
- Access tokens can be stored in memory or short-term storage
- Never expose refresh tokens in URLs or browser storage

### Rate Limiting & Abuse Prevention
- Tokens track last used timestamp
- Automatic cleanup of expired tokens
- Maximum of 5 active refresh tokens per user
- Failed attempts are logged but not exposed to users

### Compromise Response
If a refresh token is compromised:
1. Immediately revoke the specific token: `POST /auth/revoke`
2. Or revoke all tokens: `POST /auth/revoke-all`
3. Monitor token usage logs for suspicious activity

---

## Configuration

### Environment Variables

```bash
JWT_SECRET=your-super-secret-key
ACCESS_TOKEN_EXPIRY=15m   # 15 minutes
REFRESH_TOKEN_EXPIRY=7d   # 7 days
MAX_REFRESH_TOKENS_PER_USER=5
```

### Service Configuration

```typescript
const refreshTokenService = new RefreshTokenService({
  jwtSecret: process.env.JWT_SECRET!,
  accessTokenExpiry: process.env.ACCESS_TOKEN_EXPIRY || '15m',
  refreshTokenExpiry: process.env.REFRESH_TOKEN_EXPIRY || '7d'
});
```

---

## Testing

### Test Coverage

- ✅ Single refresh → new pair; old row revoked; family preserved
- ✅ 10 concurrent refreshes → exactly 1 success; rest `REVOKED_TOKEN`; family fully revoked
- ✅ Revoked token reuse → `REVOKED_TOKEN`; all user tokens revoked
- ✅ Expired token → `EXPIRED_TOKEN`
- ✅ Hash mismatch → `INVALID_REFRESH_TOKEN`
- ✅ Failed insert rolls back → old token remains valid
- ✅ REPLICA_URLS set; replica stale → consume still sees primary; reuse detected
- ✅ `listRefreshTokens` / `countActiveTokens` still use `readQuery` (replica-OK)

---

## Monitoring & Logging

### Key Metrics
- Token refresh success/failure rates
- Active token counts per user
- Token revocation events
- Security-related failures

### Log Events
- `[AuthController] Token pair rotated successfully (atomic CAS)` — successful rotation
- `[AuthController] Theft signal: revoked token presented again — all user tokens revoked` — reuse detected
- `[RefreshTokenService] Atomic token rotation succeeded` — CAS won
- `[RefreshTokenService] Refresh token reuse detected — revoking ALL user tokens as theft countermeasure.`

---

## Troubleshooting

### Common Issues

1. **"Invalid refresh token"** (`INVALID_REFRESH_TOKEN`)
   - JWT signature invalid or token not found in DB
   - Hash mismatch (different token presented for same ID)

2. **"Token has been revoked"** (`REVOKED_TOKEN`)
   - Token was already consumed by a prior refresh
   - Double-submit (same token sent twice) — re-authenticate
   - Theft scenario: the attacker rotated the stolen token first

3. **"Refresh token has expired"** (`EXPIRED_TOKEN`)
   - Token's `expires_at` is in the past; obtain a new pair by logging in again

4. **Database connection errors**
   - `consumeRefreshToken` acquires a dedicated primary client via `pool.connect()`
   - Ensure `DATABASE_URL` points to the primary (writable) database
