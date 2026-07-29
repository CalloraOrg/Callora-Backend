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
