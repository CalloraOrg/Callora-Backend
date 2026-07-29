# Fee Abstraction API

The fee-abstraction service lets developers pay Stellar transaction fees using app tokens rather than holding XLM. The backend wraps the developer's inner transaction in a Stellar fee-bump transaction signed by the platform fee account.

## Overview

1. Developer builds and signs an inner Stellar transaction.
2. Developer calls `POST /api/billing/fee-abstraction/quote` to get the XLM fee and its app-token equivalent.
3. Developer submits an app-token payment for that amount (off-chain).
4. Developer calls `POST /api/billing/fee-abstraction` with the inner XDR and the payment reference.
5. The backend creates and signs a fee-bump transaction; the caller receives the signed XDR for submission to Horizon.

---

## Endpoints

### `POST /api/billing/fee-abstraction/quote`

Returns an estimated fee for wrapping the supplied inner transaction.

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
  "baseFeeStroops": 100,
  "feeBumpFeeStroops": 600,
  "feeBumpFeeXlm": "0.0000600",
  "appTokenAmount": "0.0000060",
  "network": "testnet"
}
```

| Field | Description |
|---|---|
| `baseFeeStroops` | Per-operation base fee in stroops |
| `feeBumpFeeStroops` | Total outer fee for the fee-bump envelope |
| `feeBumpFeeXlm` | `feeBumpFeeStroops` expressed in XLM |
| `appTokenAmount` | Equivalent app-token amount to charge (based on current XLM/token rate) |
| `network` | Active Stellar network (`testnet` or `mainnet`) |

**Errors:**

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | `innerXdr` missing, empty, or not a valid Stellar transaction XDR |
| `401` | `UNAUTHORIZED` | Missing or invalid Bearer token |

---

### `POST /api/billing/fee-abstraction`

Creates and signs a fee-bump transaction wrapping the supplied inner transaction.

**Authentication:** Bearer token required.

**Request body:**

```json
{
  "innerXdr": "<base64-encoded Stellar transaction XDR>",
  "appTokenPaymentTxId": "<payment reference confirming app-token deduction>"
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

---

## Fee Calculation

The outer fee-bump fee is calculated as:

```
feeBumpFeeStroops = BASE_FEE × FEE_BUMP_MULTIPLIER × (inner_op_count + 1)
```

- `BASE_FEE` defaults to `100` stroops (override via `STELLAR_BASE_FEE`).
- `FEE_BUMP_MULTIPLIER` is `3` (hardcoded to ensure the fee-bump envelope is competitive).
- The app-token equivalent uses an approximate XLM → app-token exchange rate of `0.10 USDC/XLM` (for indicative quoting only).

---

## Security Considerations

- **Signing key**: The fee account's Stellar secret key is read from `FEE_BUMPER_SECRET_KEY` at runtime. Store this as a secrets-manager or environment secret—never commit it to source control.
- **Authentication**: Both endpoints require a valid developer Bearer token. Unauthenticated requests are rejected with `401`.
- **No double-spend protection**: The `appTokenPaymentTxId` field is recorded in the `fee_abstraction.executed` event for audit purposes but is not validated against an on-chain payment in this initial version. Callers must ensure the payment has been deducted before invoking the execution endpoint.
- **Network isolation**: The backend only builds transactions for the configured `STELLAR_NETWORK`. Cross-network mixing is rejected.

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
