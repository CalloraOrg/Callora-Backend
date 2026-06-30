# Grafana Dashboards

This directory contains committed Grafana dashboard JSON files for the Callora backend.
Import them via **Dashboards → Import → Upload JSON file** in your Grafana instance.

---

## `soroban-billing.json` — Soroban Billing Observability

**UID:** `callora-soroban-billing`  
**Grafana version:** 11.5.2  
**Datasource:** Prometheus (variable `$datasource`, type `prometheus`)

### Rows and panels

| Row | Panel | Description |
|-----|-------|-------------|
| Deduction Latency | P50 / P95 line chart | `billing_deduct_duration_seconds` histogram quantiles over time |
| Deduction Latency | P50 stat (current) | Instant P50 deduct latency |
| Deduction Latency | P95 stat (current) | Instant P95 deduct latency |
| Deduction Latency | Bucket distribution | Per-bucket rate bars for full latency shape |
| Error Category Breakdown | Rate by status code | Maps HTTP status → `SorobanRpcErrorCategory` |
| Error Category Breakdown | Total errors bar chart | Aggregate error count by category over selected range |
| Call Rate & Throughput | Deduct call rate | Total `POST /api/billing/deduct` requests/s |
| Call Rate & Throughput | Success rate | 200 / total; drops signal billing failures |

### Metric names and provenance

| Metric | Type | Registered in | Labels |
|--------|------|---------------|--------|
| `billing_deduct_duration_seconds` | Histogram | `src/metrics/registry.ts` | `route`, `status_code` |
| `billing_deduct_duration_seconds_bucket` | (auto) | `src/metrics/registry.ts` | `route`, `status_code`, `le` |
| `http_requests_total` | Counter | `src/metrics.ts` | `method`, `route`, `status_code`, `route_group` |
| `http_request_duration_seconds` | Histogram | `src/metrics.ts` | `method`, `route`, `status_code`, `route_group` |

All metrics are exposed at `GET /api/metrics` (Prometheus text format).  
In production the endpoint requires `Authorization: Bearer $METRICS_API_KEY`.

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

Legacy dashboard focused on HTTP-level deduct latency percentiles.
See `docs/grafana-dashboard-billing-deduct.json` for details.
