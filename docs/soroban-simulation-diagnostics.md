# Soroban Simulation Diagnostics

When Soroban contract simulation fails during deposit preparation or billing deduction, the backend preserves structured diagnostics on the internal error/result as `simulationDetails`.

Internal diagnostics can include:

- `errorCode`: RPC or contract error code when provided.
- `errorMessage`: normalized simulation failure message.
- `events`: sanitized diagnostic events.
- `footprint`: sanitized footprint or transaction data.

API responses expose only a redacted summary:

```json
{
  "code": "SIMULATION_FAILED",
  "error": "Soroban simulation failed",
  "simulationDetails": {
    "errorCode": "tx_failed",
    "errorMessage": "contract failed",
    "eventCount": 1,
    "footprintPresent": true
  }
}
```

Full account identifiers, contract identifiers, balances, XDR, keys, signatures, and hashes are redacted before diagnostics are returned to callers. Server-side warning logs retain the structured internal diagnostics for support debugging.

## Vault contract error codes

The billing deduct client (`SorobanVaultBillingClient`) decodes the numeric
discriminant from `Error(Contract, #N)` strings returned by simulation or by a
failed transaction, stores it as `simulationDetails.errorCode`, and maps it to
a stable category that drives the HTTP status:

| Code | `VaultError` | Category | Billing outcome | Typical HTTP response |
|---|---|---|---|---|
| 5 | `InsufficientBalance` | `INSUFFICIENT_BALANCE` | Row voided (definitive). Detected earlier by the balance pre-check → 402 without contract details. | 502 `SIMULATION_FAILED` with `errorCode: 5`, or 402 `INSUFFICIENT_BALANCE` |
| 3 | `Unauthorized` | `CONTRACT_ERROR` | Row voided (definitive) — the backend key is not the vault's `authorized_caller` | 502 `SIMULATION_FAILED` with `errorCode: 3` |
| 4 | `Paused` | `CONTRACT_ERROR` | Row voided (definitive) — the vault is paused | 502 `SIMULATION_FAILED` with `errorCode: 4` |
| 7 | `ExceedsMaxDeduct` | `CONTRACT_ERROR` | Row voided (definitive) — amount above the vault's `max_deduct` cap | 502 `SIMULATION_FAILED` with `errorCode: 7` |
| 29 | `DuplicateRequestId` | resolved or `TIMEOUT` | The request id was already processed: the client returns the original transaction hash when it can confirm it, otherwise reports an unknown outcome so the row stays **pending** (never voided, never double charged) | 200 with the original `stellarTxHash`, or 409 `RECONCILIATION_REQUIRED` |

Failures with no decodable code keep the message-based classification
(`simulation failed`/`contract` → `CONTRACT_ERROR`, transport errors →
`NETWORK_ERROR`, deadline exhausted → `TIMEOUT`). `NETWORK_ERROR` and
`TIMEOUT` are transient for `BillingService`: the deduction is retried with
the same `onchain_request_id`, and when the attempts run out the row stays
pending (409 `RECONCILIATION_REQUIRED`) instead of being voided.

Because every coded contract failure carries `simulationDetails`, the billing
route renders it through the canonical redacted envelope — the numeric code
survives redaction while addresses, XDR, keys and hashes do not:

```json
{
  "code": "SIMULATION_FAILED",
  "simulationDetails": {
    "errorCode": 4,
    "errorMessage": "io.callora: Error(Contract, #4)",
    "eventCount": 0,
    "footprintPresent": false
  }
}
```
