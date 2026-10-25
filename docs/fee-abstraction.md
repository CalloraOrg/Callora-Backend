# Fee Abstraction API

The fee-abstraction service lets developers pay Stellar transaction fees using app tokens rather than holding XLM. The backend wraps the developer's inner transaction in a Stellar fee-bump transaction signed by the platform fee account.

## Overview

1. Developer builds and signs an inner Stellar transaction.
2. Developer calls `POST /api/billing/fee-abstraction/quote` to persist a single-use quote and receive its expiry, exact amount, asset, treasury and payment memo hash.
3. From the user's bound Stellar account, developer sends an on-chain payment in the quoted credit asset to the quoted treasury. Set `MEMO_HASH` to the returned hash: `Memo.hash(Buffer.from(quote.paymentMemoHashHex, 'hex'))`.
4. Developer calls `POST /api/billing/fee-abstraction` with the `quoteId`, unchanged inner XDR and the successful payment's 64-hex transaction hash.
5. The backend verifies payment through the configured Horizon, atomically consumes the quote and signs. The signed XDR is returned only after the database commit; the caller submits it to Horizon.

---

## Endpoints

### `POST /api/billing/fee-abstraction/quote`

Persists a pending quote bound to the authenticated user, inner transaction hash, network, fee, amount and expiry. The user must already have a valid bound Stellar account.

**Authentication:** Bearer token required.

**Request body:**

```json
{
  "innerXdr": "<base64-encoded Stellar transaction XDR>"
}
```

**Response `200`:**

```json
{
  "quoteId": "68eeab90-cf4c-4f31-af4e-0bc68aa119db",
  "expiresAt": "2026-10-21T18:45:00.000Z",
  "baseFeeStroops": 100,
  "feeBumpFeeStroops": 600,
  "feeBumpFeeXlm": "0.0000600",
  "appTokenAmount": "0.0000060",
  "appTokenAssetCode": "APP",
  "appTokenIssuer": "G...",
  "treasuryAddress": "G...",
  "paymentMemoHashHex": "<64 hex characters>",
  "network": "testnet"
}
```

| Field | Description |
|---|---|
| `quoteId`, `expiresAt` | Single-use quote UUID and ISO-8601 expiry |
| `appTokenAssetCode`, `appTokenIssuer` | Exact Stellar credit asset required for payment |
| `treasuryAddress` | Required payment destination |
| `paymentMemoHashHex` | 32-byte `sha256("fee-abstraction-quote:" + quoteId)` commitment, hex encoded; use as a hash memo |
| `baseFeeStroops` | Per-operation base fee in stroops |
| `feeBumpFeeStroops` | Total outer fee for the fee-bump envelope |
| `feeBumpFeeXlm` | `feeBumpFeeStroops` expressed in XLM |
| `appTokenAmount` | Exact payment amount as a seven-decimal token string |
| `network` | Active Stellar network (`testnet` or `mainnet`) |

**Errors:**

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | `innerXdr` missing, empty, or not a valid Stellar transaction XDR |
| `401` | `UNAUTHORIZED` | Missing or invalid Bearer token |
| `403` | `FORBIDDEN` | User has no valid bound Stellar account |
| `500` | `INTERNAL_SERVER_ERROR` | Database, treasury or asset configuration is unavailable or invalid |

---

### `POST /api/billing/fee-abstraction`

Verifies the quote-bound on-chain payment, consumes the quote once, and returns a signed fee-bump envelope at the quoted fee.

**Authentication:** Bearer token required.

**Request body:**

```json
{
  "quoteId": "68eeab90-cf4c-4f31-af4e-0bc68aa119db",
  "innerXdr": "<base64-encoded Stellar transaction XDR>",
  "appTokenPaymentTxId": "<64-hex on-chain transaction hash>"
}
```

**Response `200`:**

```json
{
  "feeBumpXdr": "<signed fee-bump transaction XDR>",
  "feeAccountPublicKey": "G...",
  "feeStroops": 600
}
```

| Field | Description |
|---|---|
| `feeBumpXdr` | Signed fee-bump transaction XDR; submit directly to Horizon |
| `feeAccountPublicKey` | Public key of the platform fee account |
| `feeStroops` | Total fee charged by the fee-bump envelope |

**Errors:**

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Missing/empty fields or invalid `innerXdr` |
| `401` | `UNAUTHORIZED` | Missing or invalid Bearer token |
| `500` | `INTERNAL_SERVER_ERROR` | Fee-bumper not configured or signing failed |
| `402` | `PAYMENT_REQUIRED` | Missing, failed, mismatched, unbound or already-used payment |
| `403` | `FORBIDDEN` | No Stellar account is bound to this user |
| `404` | `NOT_FOUND` | Quote does not exist or belongs to another user |
| `409` | `CONFLICT` | Quote is consumed, expired, for another network, or no longer matches the current fee policy |
| `503` | `SERVICE_UNAVAILABLE` | Horizon is unavailable or returns malformed payment evidence |

---

## Fee Calculation

The outer fee-bump fee is calculated as:

```
outer_per_op = max(configured_base_fee × 3, ceil((inner_fee − inner_resource_fee) / inner_ops), 100)
feeBumpFeeStroops = inner_resource_fee + outer_per_op × (inner_ops + 1)
```

- `BASE_FEE` defaults to `100` stroops (override via `STELLAR_BASE_FEE`).
- `FEE_BUMP_MULTIPLIER` is `3` (hardcoded to ensure the fee-bump envelope is competitive).
- The configured fee is a policy floor, not permission to underbid the inner transaction. Soroban resource fees are included once.
- The SDK receives the per-operation outer rate, not the already-multiplied total. The signed envelope fee equals the quoted total exactly.
- The app-token rate is `FEE_ABSTRACTION_RATE_NUMERATOR / FEE_ABSTRACTION_RATE_DENOMINATOR` tokens per XLM (default `1/10`). Payment amounts round up to whole seven-decimal token units; this configured rate is not a market-price guarantee.

---

## Security Considerations

- **Signing key**: The fee account's Stellar secret key is read from `FEE_BUMPER_SECRET_KEY` at runtime. Store this as a secrets-manager or environment secret—never commit it to source control.
- **Authentication**: Both endpoints require a valid developer Bearer token. Unauthenticated requests are rejected with `401`.
- **Payment authorization**: Horizon must report a successful transaction whose hash memo commits to this quote. Exactly one matching credit-asset payment must come from the user's bound account to the configured treasury for the exact quoted amount; payments predating the quote are rejected.
- **Network configuration**: The backend builds fee-bump envelopes for the configured `STELLAR_NETWORK`. Inner XDR does not encode its signing network; clients must sign for that same network.
- **Single use and expiry**: A conditional database update consumes only a pending, unexpired quote owned by the caller; a unique payment-ID index prevents reuse. Signing and the actual envelope-fee check occur inside that transaction. Failed signing rolls back; no signed envelope is returned before commit. A lost response or ambiguous commit requires reconciliation, not a new signature using the same payment.

---

## Rate Limiting

The fee-abstraction endpoints are mounted under `/api/billing` and inherit the same REST rate limit applied to all billing routes:

- Window: `REST_RATE_LIMIT_WINDOW_MS` (default `60000` ms)
- Max requests: `REST_RATE_LIMIT_MAX_REQUESTS` (default `100`)
- Key: `user:<userId>` for authenticated requests, `ip:<ip>` fallback

When the limit is exceeded, a `429 Too Many Requests` response is returned with a `Retry-After` header.

---

## Emitted Events

After a successful execution, the `fee_abstraction.executed` event is emitted:

```ts
{
  userId: string;               // authenticated developer ID
  appTokenPaymentTxId: string;  // payment reference from the request
  feeAccountPublicKey: string;  // public key of the fee account
  feeStroops: number;           // total fee paid in stroops
  feeBumpXdr: string;           // signed fee-bump XDR
}
```

This event can trigger downstream webhook deliveries if the developer has subscribed to `fee_abstraction.executed` events.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FEE_BUMPER_SECRET_KEY` | **Yes** | Stellar secret key (`S...`) for the platform fee account |
| `STELLAR_BASE_FEE` | No (default `100`) | Base fee per operation in stroops |
| `STELLAR_NETWORK` | No (default `testnet`) | Active network: `testnet` or `mainnet` |
| `FEE_ABSTRACTION_TREASURY_ADDRESS` | **Yes** | Stellar public key receiving app-token payments |
| `FEE_ABSTRACTION_APP_TOKEN_ISSUER` | **Yes** | Issuer public key of the accepted credit asset |
| `FEE_ABSTRACTION_APP_TOKEN_ASSET_CODE` | No (default `APP`) | Valid Stellar credit-asset code |
| `FEE_ABSTRACTION_RATE_NUMERATOR`, `FEE_ABSTRACTION_RATE_DENOMINATOR` | No (default `1`, `10`) | Positive integer app-token/XLM conversion ratio |
| `FEE_ABSTRACTION_QUOTE_TTL_SECONDS` | No (default `300`) | Quote validity window |
| `FEE_ABSTRACTION_PAYMENT_VERIFY_TIMEOUT_MS` | No (default `4000`) | Maximum Horizon verification duration; must be below `BILLING_TIMEOUT_MS` (default `5000`) when that deadline is enabled. A violation returns HTTP 500 before any quote or payment work |

## Verification

The route suite uses synthetic Horizon responses and a PostgreSQL engine in memory. The native regression below additionally requires a fresh, disposable PostgreSQL database and observes distinct backend PIDs and real row-lock/unique-index waits:

```sh
npm run build
node tests/integration/feeAbstraction.postgres.mjs --dsn 'postgresql://fixture@127.0.0.1:60024/postgres' --disposable
```

It creates and removes only its own randomly named test schema. Checks cover a single winning execution, rollback releasing a waiter, payment-ID contention and expiry during a lock wait. Signing is synthetic in this database regression; it does not move funds or contact Horizon.

The request deadline (`BILLING_TIMEOUT_MS`) cancels in-flight Horizon verification and aborts the consume transaction at its checkpoints (before connecting, after the quote row lock, and before signing). A request cancelled before signing rolls back, leaving the quote `pending` so it can be retried. Once `COMMIT` returns, the quote is consumed; cancellation does not make the HTTP response delivery atomic with that authorization, so clients must not assume a fee-bump was delivered when the response is lost after commit.

Protocol references: Stellar's [transaction object](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/transactions/object) and [payment object](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/payments/object).
