# PR: Grafana Dashboard for Soroban Billing Observability

## Summary

Adds a committed Grafana dashboard JSON (`docs/dashboards/soroban-billing.json`) so on-call engineers can see Soroban billing deduction latency (P50/P95), error category breakdown, and call rate out of the box — no manual panel creation required.

## Changes

### New files
- `docs/dashboards/soroban-billing.json` — Grafana 11.5.2 dashboard with three rows: Deduction Latency, Error Category Breakdown, Call Rate & Throughput
- `docs/dashboards/README.md` — Documents metric names, provenance, error category → HTTP status mapping, bucket boundaries, SLO thresholds, and import instructions

### Modified files
- `README.md` — Observability section now links to both dashboards under `docs/dashboards/`

## Dashboard panels

| Row | Panels |
|-----|--------|
| Deduction Latency | P50/P95 line chart, P50 stat, P95 stat, bucket distribution bars |
| Error Category Breakdown | Rate by HTTP status (proxy for `SorobanRpcErrorCategory`), total error bar chart |
| Call Rate & Throughput | Total call rate, success rate gauge |

## Metric provenance

| Metric | Source file |
|--------|-------------|
| `billing_deduct_duration_seconds` | `src/metrics/registry.ts` — recorded by `billingDeductHistogramMiddleware` |
| `http_requests_total` | `src/metrics.ts` — recorded by `metricsMiddleware` |

Labels used: `route="/api/billing/deduct"`, `status_code` (maps to `SorobanRpcErrorCategory`).

## Validation

The JSON can be validated with:
```bash
# Parse check
node -e "JSON.parse(require('fs').readFileSync('docs/dashboards/soroban-billing.json','utf8')); console.log('valid')"
```

## Security

- No private data baked in (no hardcoded IPs, tokens, or secrets)
- Datasource UID is a `$datasource` template variable — resolves at import time
- Grafana version pinned to `11.5.2` in `__requires`

closes #415
