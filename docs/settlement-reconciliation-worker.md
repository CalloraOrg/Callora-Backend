# Settlement Reconciliation Worker

The settlement reconciliation worker performs periodic nightly audits comparing database settlement status with on-chain Stellar Horizon transaction data. It detects discrepancies such as completed settlements with missing on-chain transactions, stale pending settlements that are actually confirmed on-chain, and false failures where DB records marked as failed are actually successful on Stellar.

## Overview

The worker wraps the `SettlementReconciliationJob` service layer class and runs on a configurable interval (default: 24 hours). It follows the standard Callora worker pattern with lifecycle hooks (`start`, `stop`, `beginShutdown`, `awaitIdle`) and integrates with the application's graceful shutdown flow.

## Configuration

The worker is configured via environment variables and application config:

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SETTLEMENT_RECON_INTERVAL_MS` | `86400000` (24 hours) | Interval between reconciliation runs in milliseconds |
| `SETTLEMENT_STATUS_SYNC_TIMEOUT_MS` | `5000` | Per-request timeout for Horizon API calls in milliseconds |

The worker uses the active Stellar network's Horizon URL from the `STELLAR_NETWORK` configuration (testnet or mainnet).

## Architecture

```
┌─────────────────────────────────────┐
│ src/workers/settlementRecon.ts      │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ createSettlementReconWorker │   │
│  │                             │   │
│  │ • Interval timer            │   │
│  │ • Overlap protection        │   │
│  │ • Graceful shutdown         │   │
│  └──────────┬──────────────────┘   │
│             │                       │
└─────────────┼───────────────────────┘
              │ wraps
              ▼
┌─────────────────────────────────────┐
│ src/services/settlementReconcilia.. │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ SettlementReconciliationJob │   │
│  │                             │   │
│  │ • Query settlements DB      │   │
│  │ • Fetch Horizon tx status   │   │
│  │ • Classify discrepancies    │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

## Discrepancy Types

The worker detects and reports the following discrepancy types:

| Type | DB Status | Horizon Status | Description |
|------|-----------|----------------|-------------|
| `MISSING_TX` | `completed` | not found / failed | Settlement marked completed in DB but transaction is missing or failed on-chain |
| `STALE_PENDING` | `pending` / `retryable` | successful | Settlement still pending in DB but transaction is already confirmed on-chain |
| `FALSE_FAILURE` | `failed` | successful | Settlement marked failed in DB but transaction is successful on-chain |
| `UNEXPECTED_STATUS` | other | not found | Settlement in unexpected state when transaction not found |

## Lifecycle

### Startup

```typescript
const worker = createSettlementReconWorker(pool, {
  intervalMs: 86_400_000,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  horizonRequestTimeoutMs: 5_000,
});

worker.start();
```

The worker performs an **immediate initial scan** on startup, then schedules subsequent scans at the configured interval.

### Shutdown

The worker implements graceful shutdown through the `DrainableSubsystem` interface:

1. **`beginShutdown()`** — Stop accepting new reconciliation runs
2. **`awaitIdle()`** — Wait for the current in-flight run to complete
3. **`stop()`** — Clear the interval timer

This ensures no reconciliation run is interrupted mid-flight during application shutdown.

```typescript
// Registered in src/index.ts:
{
  name: "settlement-reconciliation",
  beginShutdown: () => settlementReconJob.beginShutdown(),
  awaitIdle: () => settlementReconJob.awaitIdle(),
}
```

## Overlap Protection

The worker implements automatic overlap protection: if a reconciliation run is still in progress when the next interval tick arrives, the worker skips the new tick and waits for the current run to finish. This prevents concurrent reconciliation jobs from overloading the database or Horizon API.

## Error Handling

- **Horizon transient errors** (503, 429) are automatically retried with exponential backoff (configured via `horizonMaxRetries` and `horizonRetryBaseDelayMs`)
- **Horizon 404 responses** (transaction not found) are treated as expected states for pending settlements
- **Job failures** are logged with structured error details but do not crash the worker
- The worker continues scheduling future runs after errors

## Monitoring

Reconciliation runs emit structured logs:

```json
{
  "type": "info",
  "message": "Settlement reconciliation run complete",
  "runAt": "2026-07-24T11:00:00.000Z",
  "checked": 150,
  "ok": 148,
  "discrepancies": 2,
  "errors": 0
}
```

Each discrepancy is logged with details:

```json
{
  "type": "warn",
  "message": "Settlement reconciliation discrepancy",
  "settlementId": "stl_abc123",
  "developerId": "dev_456",
  "type": "STALE_PENDING",
  "dbStatus": "pending",
  "horizonStatus": "successful",
  "txHash": "0x7f3b9a..."
}
```

## Testing

The worker has comprehensive unit test coverage in `src/workers/settlementRecon.test.ts`:

- ✅ Construction validation (intervalMs constraints)
- ✅ Initial scan on start
- ✅ Periodic interval ticks
- ✅ Overlap protection
- ✅ Graceful shutdown hooks
- ✅ Error handling and recovery
- ✅ Logger integration
- ✅ Pool query wrapping

Run tests with:

```bash
npm test -- src/workers/settlementRecon.test.ts
```

## Related Documentation

- [Settlement Store](../SETTLEMENT_STORE_DOCUMENTATION.md) — Settlement persistence layer
- [Graceful Shutdown](./graceful-shutdown.md) — Application shutdown flow
- [Settlement Reconciliation Job](../src/services/settlementReconciliationJob.ts) — Core reconciliation logic

## Security Considerations

- The worker requires read-only access to the `settlements` table
- Horizon API requests are bounded by timeout and retry limits to prevent resource exhaustion
- No sensitive data (developer balances, transaction details) is logged
- All structured logs are sanitized through the application logger's redaction layer
