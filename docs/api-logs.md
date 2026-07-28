# API Logs Proxy Endpoint

The `/api/logs` endpoint acts as a reverse proxy for downstream logging services, forwarding requests to the configured `UPSTREAM_URL/logs` and applying per-endpoint circuit breaker protection to prevent cascading failures.

## Features

- **Per-Endpoint Circuit Breaking**: Each distinct downstream endpoint (e.g. `/api/logs/system` vs `/api/logs/audit`) is tracked independently by the `BreakerRegistry`.
- **Fast-Fail on Open**: If the downstream service begins failing and the circuit breaker trips to `OPEN`, the gateway fast-fails immediately with HTTP `503 Service Unavailable`, protecting both the gateway resources and the downstream logging service during an outage.
- **Support for All Methods**: The endpoint supports arbitrary HTTP verbs (`GET`, `POST`, `PUT`, `DELETE`, etc.) and seamlessly proxies the request body.

## API Reference

### `ALL /api/logs/:endpoint(*)`

Proxies the request to the upstream logging server. 

**Path Parameters**:
- `endpoint` (optional): The specific downstream log path. For example, `GET /api/logs/system/metrics` will proxy to `UPSTREAM_URL/logs/system/metrics`.

**Headers**:
- Passes through `Authorization` and `Content-Type`.

## Circuit Breaker Behavior

The underlying circuit breaker is configured with the following defaults:
- **Failure Threshold**: 5 consecutive failures before opening.
- **Cooldown**: 30 seconds before attempting a half-open probe.
- **Success Threshold**: 1 successful probe to close the breaker and resume normal traffic.

When the breaker is `OPEN`, the gateway returns:

```json
{
  "success": false,
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "Downstream logs endpoint is currently unavailable: Circuit breaker is open. Cooldown remaining: 29999ms"
  }
}
```

Unexpected errors (e.g. invalid response format, connection timeout) are returned as:

```json
{
  "success": false,
  "error": {
    "code": "BAD_GATEWAY",
    "message": "Upstream error message"
  }
}
```
