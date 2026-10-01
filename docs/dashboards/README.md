# Grafana Dashboards

This directory contains committed Grafana dashboard JSON files for the Callora backend.
Import them via **Dashboards → Import → Upload JSON file** in your Grafana instance.

Every metric queried by these dashboards must be registered in code **and** exposed by
`GET /api/metrics`. That mapping is enforced by the unit test
[`src/__tests__/dashboardMetrics.test.ts`](../../src/__tests__/dashboardMetrics.test.ts),
which parses the PromQL expressions in these JSON files and asserts that each metric
selector is registered:

```bash
npm test -- src/__tests__/dashboardMetrics.test.ts
```

Metric registrations live in two files:

| File | Registry | Notes |
|------|----------|-------|
| `src/metrics.ts` | shared registry exported as `register`, served by `GET /api/metrics` | HTTP, gateway, DB, SLO and worker metrics |
| `src/metrics/registry.ts` | per-route latency histograms | Also registered into the shared registry so Grafana can scrape them |

All metrics are exposed at `GET /api/metrics` (Prometheus text format).
In production the endpoint requires `Authorization: Bearer $METRICS_API_KEY`.

---

## `soroban-billing.json` — Soroban Billing Observability

**UID:** `callora-soroban-billing`  
**Grafana version:** 11.5.2  
**Datasource:** Prometheus (variable `$datasource`, type `prometheus`)

### Panels and metrics

| Row | Panel | Panel type | PromQL metric selector(s) | Description |
|-----|-------|------------|---------------------------|-------------|
| Deduction Latency | Deduct Latency — P50 / P95 | Time series | `billing_deduct_duration_seconds_bucket` | `histogram_quantile(0.50/0.95, sum by (le)(rate(...)))` over the deduct histogram |
| Deduction Latency | P50 Deduct Latency (current) | Stat | `billing_deduct_duration_seconds_bucket` | Instant P50 deduct latency |
| Deduction Latency | P95 Deduct Latency (current) | Stat | `billing_deduct_duration_seconds_bucket` | Instant P95 deduct latency |
| Deduction Latency | Deduct Duration — Bucket Distribution | Time series | `billing_deduct_duration_seconds_bucket` | Per-bucket rate bars for the full latency shape |
| Error Category Breakdown | Deduct Request Rate by Status Code (Error Category Proxy) | Time series | `http_requests_total` | `sum by (status_code)`; maps HTTP status → `SorobanRpcErrorCategory` |
| Error Category Breakdown | Total Deduct Errors by Category (selected range) | Bar chart | `http_requests_total` | `sum by (status_code)(increase(...[$__range]))` |
| Call Rate & Throughput | Deduct Call Rate (all outcomes) | Time series | `http_requests_total` | Total `POST /api/billing/deduct` requests/s |
| Call Rate & Throughput | Deduct Success Rate | Time series | `http_requests_total` | 200 / total; drops signal billing failures |

### Metric names and provenance

| Metric | Type | Registered in | Labels |
|--------|------|---------------|--------|
| `billing_deduct_duration_seconds` | Histogram | `src/metrics/registry.ts` | `route`, `status_code` |
| `billing_deduct_duration_seconds_bucket` | (auto) | `src/metrics/registry.ts` | `route`, `status_code`, `le` |
| `http_requests_total` | Counter | `src/metrics.ts` | `method`, `route`, `status_code`, `route_group` |

### Error category → HTTP status mapping

The `SorobanRpcErrorCategory` enum (defined in `src/services/sorobanBilling.ts`) maps to
HTTP status codes in `src/routes/billing.ts`:

| `SorobanRpcErrorCategory` | HTTP status | Panel colour |
|---------------------------|-------------|--------------|
| *(success)* | 200 | green |
| `INSUFFICIENT_BALANCE` | 402 | yellow |
| `CONTRACT_ERROR` | 502 | red |
| `NETWORK_ERROR` | 502 | red |
| `TIMEOUT` | 504 | orange |
| `SIMULATION_FAILED` (diagnostics) | 502 | red |

Because the histogram middleware and counter both record `status_code` as a label,
the dashboard slices errors by category without requiring a dedicated per-category counter.

### Bucket boundaries

`billing_deduct_duration_seconds` uses these buckets (seconds):

```
0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
```

The SLO thresholds on the latency panels are:
- **green** → < 500 ms
- **yellow** → 500 ms – 2 s
- **red** → > 2 s

### Datasource variable

The dashboard uses a `$datasource` template variable of type `datasource` (Prometheus).
On import, Grafana will prompt you to select your Prometheus datasource. No UID is hardcoded —
the variable resolves at runtime so the dashboard works across environments.

### Import instructions

1. Open Grafana → **Dashboards → Import**
2. Click **Upload JSON file** and select `docs/dashboards/soroban-billing.json`
3. Select your Prometheus datasource when prompted
4. Click **Import**

To provision automatically, copy the JSON to your Grafana provisioning
`dashboards/` directory and add a provider config pointing at that folder.

---

## `../grafana-dashboard-billing-deduct.json` — Billing Deduct HTTP Latency

**UID:** `callora-billing-deduct-latency`
**Location:** `docs/grafana-dashboard-billing-deduct.json` (legacy path, kept at `docs/`)
**Grafana version:** 11.5.2
**Datasource:** Prometheus (variable `$datasource`, type `prometheus`)

Focused, HTTP-level view of `POST /api/billing/deduct` latency percentiles. It shares the
same `billing_deduct_duration_seconds` histogram as `soroban-billing.json`.

### Panels and metrics

| Row | Panel | Panel type | PromQL metric selector(s) | Description |
|-----|-------|------------|---------------------------|-------------|
| Billing Deduct Latency | Billing Deduct Duration (Cumulative Distribution) | Time series | `billing_deduct_duration_seconds_bucket` | `rate(...)` per `le` bucket over the selected range |
| Billing Deduct Latency | Billing Deduct Latency Percentiles (P50 / P95 / P99) | Time series | `billing_deduct_duration_seconds_bucket` | `histogram_quantile(0.50/0.95/0.99, ...)` |

### Metric names and provenance

| Metric | Type | Registered in | Labels |
|--------|------|---------------|--------|
| `billing_deduct_duration_seconds` | Histogram | `src/metrics/registry.ts` | `route`, `status_code` |
| `billing_deduct_duration_seconds_bucket` | (auto) | `src/metrics/registry.ts` | `route`, `status_code`, `le` |
