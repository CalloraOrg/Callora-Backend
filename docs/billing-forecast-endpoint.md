# Billing Forecast Endpoint Documentation

**Endpoint:** `GET /api/billing/forecast`  
**Issue:** #543 Add /api/billing/forecast endpoint  
**Feature:** Forecast next-period bill based on historical consumer run rate.

## Overview

The `/api/billing/forecast` endpoint allows authenticated developers to forecast their upcoming billing amount based on their actual current consumer run rate over a configurable historical lookback window.

Only charges confirmed on-chain (`stellar_tx_hash IS NOT NULL`) where the caller was the consumer (`user_id = $1`) are counted toward spend; developer revenue from APIs owned by the caller is strictly excluded.

## Authentication

Requires Bearer JWT token or `x-user-id` header (via `requireAuth` middleware). Unauthenticated requests return `401 Unauthorized`.

## Query Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `lookbackDays` | integer | No | `30` | Number of past days used to calculate current daily run rate (Min: 1, Max: 90). |
| `period` | string | No | `'month'` | Target forecast period: `'month'`, `'next_30_days'`, `'week'`, `'day'`, `'quarter'`. |

Target forecast period lengths:
- `'day'`: 1 day
- `'week'`: 7 days
- `'month'`: 30 days
- `'next_30_days'`: 30 days
- `'quarter'`: 90 days

## Response Format

### Success Response (`200 OK`)

```json
{
  "userId": "dev-user-123",
  "lookbackDays": 30,
  "lookbackStart": "2026-06-27T21:22:47.000Z",
  "lookbackEnd": "2026-07-27T21:22:47.000Z",
  "windowSpentUsdc": "90.0000000",
  "dailyRunRateUsdc": "3.0000000",
  "forecastPeriod": "month",
  "forecastDays": 30,
  "forecastedAmountUsdc": "90.0000000",
  "totalCalls": 45,
  "currency": "USDC",
  "generatedAt": "2026-07-27T21:22:47.000Z"
}
```

### Response Fields

- **`userId`**: Authenticated developer/user ID.
- **`lookbackDays`**: Number of days evaluated for current run rate.
- **`lookbackStart`**: ISO timestamp starting the lookback window.
- **`lookbackEnd`**: ISO timestamp ending the lookback window.
- **`windowSpentUsdc`**: Total USDC spent as a consumer during the lookback window, formatted to 7 decimal places ($10^{-7}$ USDC units).
- **`dailyRunRateUsdc`**: Calculated daily run rate in USDC, formatted to 7 decimal places.
- **`forecastPeriod`**: Selected target forecast period.
- **`forecastDays`**: Number of days in target forecast period.
- **`forecastedAmountUsdc`**: Forecasted bill amount in USDC, formatted to 7 decimal places.
- **`totalCalls`**: Total confirmed usage calls recorded during the lookback window.
- **`currency`**: Currency unit (`USDC`).
- **`generatedAt`**: ISO timestamp when forecast was computed.

## Formula and Rounding

All calculations are performed strictly in integer units ($1\text{ unit} = 10^{-7}\text{ USDC} = 0.0000001\text{ USDC}$) without floating-point arithmetic.

$$\text{Daily Run Rate Units} = \text{roundHalfUp}\left(\frac{\text{totalUnits}}{\text{lookbackDays}}\right)$$

$$\text{Forecasted Amount Units} = \text{roundHalfUp}\left(\frac{\text{totalUnits} \times \text{forecastDays}}{\text{lookbackDays}}\right)$$

Where `roundHalfUp(numerator, denominator)` uses standard half-up rounding (ties where $2 \times \text{remainder} \ge \text{denominator}$ round up away from zero):
- `quotient = numerator / denominator`
- `remainder = numerator % denominator`
- If $2 \times \text{remainder} \ge \text{denominator}$, result is `quotient + 1`, otherwise `quotient`.

## Database Query and Indexing

Queries are backed by the composite index `idx_usage_events_user_created` on `(user_id, created_at)`:

```sql
SELECT
  COALESCE(SUM(amount_usdc), 0)::text AS total_units,
  COUNT(*)::int                       AS calls
FROM usage_events
WHERE user_id = $1
  AND created_at >= $2
  AND created_at < $3
  AND stellar_tx_hash IS NOT NULL
```

### Query Plan (`EXPLAIN`)

```text
Aggregate  (cost=42.15..42.16 rows=1 width=40)
  ->  Bitmap Heap Scan on usage_events  (cost=4.32..42.05 rows=12 width=8)
        Recheck Cond: ((user_id = $1) AND (created_at >= $2) AND (created_at < $3))
        Filter: (stellar_tx_hash IS NOT NULL)
        ->  Bitmap Index Scan on idx_usage_events_user_created  (cost=0.00..4.31 rows=13 width=0)
              Index Cond: ((user_id = $1) AND (created_at >= $2) AND (created_at < $3))
```

## Error Codes

- `400 BAD_REQUEST`: Returned when query parameters fail validation (e.g. `lookbackDays` out of range 1-90, or invalid `period` enum).
- `401 UNAUTHORIZED`: Returned when no valid authentication credentials are provided.
- `503 FORECAST_DATA_UNAVAILABLE`: Returned in standard envelope when historical usage data cannot be retrieved from the repository or database pool.

## Caching

Supports standard `ETag` headers and returns `304 Not Modified` when requested with a matching `If-None-Match` header. ETags are deterministically derived from the stable response data fields (`userId`, `lookbackDays`, `forecastPeriod`, `forecastDays`, `windowSpentUsdc`, `dailyRunRateUsdc`, `forecastedAmountUsdc`, `totalCalls`, `currency`), ensuring stable caching across subsequent requests.
