# Usage Anomaly Detector

Background worker that compares each developer's latest 5-minute API call
volume against a rolling baseline and emits `usage.anomaly.detected` when
traffic exceeds a configurable multiplier (default **5×**).

## How it works

1. Every `USAGE_ANOMALY_POLL_INTERVAL_MS` (default 5 min) the worker scans
   developers with recent `usage_events` activity.
2. For each developer, call counts are bucketed into fixed 5-minute windows.
3. **Baseline** = arithmetic mean of the trailing **12** completed windows (configurable).
4. The **most recently completed** 5-minute window is compared to `baseline × multiplier`.
5. When the threshold is exceeded, the worker emits `usage.anomaly.detected`
   through the typed event emitter, which fans out to matching developer
   webhook subscriptions.

Missing windows in the series are treated as **zero calls** so quiet periods
do not inflate the baseline.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `USAGE_ANOMALY_DETECTOR_ENABLED` | `true` | Set to `false` to disable the worker |
| `USAGE_ANOMALY_MULTIPLIER` | `5` | Traffic must exceed `baseline × multiplier` |
| `USAGE_ANOMALY_POLL_INTERVAL_MS` | `300000` | Scan interval in ms (5 min) |
| `USAGE_ANOMALY_WINDOW_MS` | `300000` | Window size in ms (5 min) |
| `USAGE_ANOMALY_BASELINE_WINDOWS` | `12` | Trailing windows used for the baseline mean |
| `USAGE_ANOMALY_DEDUP_WINDOW_MS` | `USAGE_ANOMALY_WINDOW_MS` | Suppress duplicate alerts per developer/window |

## Event payload

```json
{
  "event": "usage.anomaly.detected",
  "timestamp": "2026-06-01T12:05:00.000Z",
  "developerId": "dev_123",
  "data": {
    "windowStart": "2026-06-01T12:00:00.000Z",
    "windowEnd": "2026-06-01T12:05:00.000Z",
    "currentCalls": 100,
    "baselineMean": 10,
    "multiplier": 5,
    "ratio": 10,
    "windowMs": 300000
  }
}
```

Developers subscribe by registering a webhook for the `usage.anomaly.detected`
event type.

## Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `usage_anomaly_detector_runs_total` | Counter | Total scan cycles completed |
| `usage_anomaly_detector_anomalies_total` | Counter | Total anomaly events emitted |

## Testing

```bash
npx jest src/services/anomalyService.test.ts src/workers/anomalyDetector.test.ts
```

## Related code

- `src/services/anomalyService.ts` — detection logic and DB aggregation
- `src/workers/anomalyDetector.ts` — interval job wrapper
- `src/events/event.emitter.ts` — webhook fan-out for `usage.anomaly.detected`

The admin `GET /api/admin/usage/anomalies` endpoint uses a separate daily
z-score detector (`usageAnomalyDetector.ts`) for retrospective review; this
worker provides real-time per-developer 5-minute spike detection.
