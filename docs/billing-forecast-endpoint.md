# Billing Forecast Endpoint Documentation

**Endpoint:** `GET /api/billing/forecast`  
**Issue:** #543 Add /api/billing/forecast endpoint  
**Feature:** Forecast next-period bill based on historical run rate.

## Overview

The `/api/billing/forecast` endpoint allows authenticated developers to forecast their upcoming billing amount based on their actual current run rate over a configurable historical lookback window.

## Authentication

Requires Bearer JWT token or `x-user-id` header (via `requireAuth` middleware). Unauthenticated requests return `401 Unauthorized`.

## Query Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `lookbackDays` | integer | No | `30` | Number of past days used to calculate current daily run rate (Min: 1, Max: 90). |
| `period` | string | No | `'month'` | Target forecast period: `'month'`, `'next_30_days'`, `'week'`, `'day'`. |

## Response Format

### Success Response (`200 OK`)

```json
{
  "userId": "dev-user-123",
  "lookbackDays": 30,
  "lookbackStart": "2026-06-27T21:22:47.000Z",
  "lookbackEnd": "2026-07-27T21:22:47.000Z",
  "windowSpentUsdc": "90.0000",
  "dailyRunRateUsdc": "3.0000",
  "forecastPeriod": "month",
  "forecastDays": 30,
  "forecastedAmountUsdc": "90.0000",
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
- **`windowSpentUsdc`**: Total USDC spent during the lookback window.
- **`dailyRunRateUsdc`**: Calculated daily run rate (`windowSpentUsdc / lookbackDays`).
- **`forecastPeriod`**: Selected target forecast period.
- **`forecastDays`**: Number of days in target forecast period.
- **`forecastedAmountUsdc`**: Forecasted bill amount (`dailyRunRateUsdc * forecastDays`).
- **`totalCalls`**: Total billing/usage calls recorded during the lookback window.
- **`currency`**: Currency unit (`USDC`).
- **`generatedAt`**: ISO timestamp when forecast was computed.

## Formula

$$\text{Daily Run Rate} = \frac{\text{Total Spend in Lookback Window}}{\text{lookbackDays}}$$

$$\text{Forecasted Bill} = \text{Daily Run Rate} \times \text{forecastDays}$$

## Error Codes

- `400 BAD_REQUEST`: Returned when query parameters fail validation (e.g. `lookbackDays` out of range 1-90, or invalid `period` enum).
- `401 UNAUTHORIZED`: Returned when no valid authentication credentials are provided.

## Caching

Supports standard `ETag` headers and returns `304 Not Modified` when requested with a matching `If-None-Match` header.
