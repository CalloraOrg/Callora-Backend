# Structured Access Logs for /api/billing

This document details the structured JSON access logging implementation for the `/api/billing` router in Callora-Backend as part of the GrantFox FWC26 campaign (`[b#003]`).

## Overview

All incoming requests to `/api/billing` endpoints pass through `billingAccessLogMiddleware` mounted at the root of the billing router (`src/routes/billing.ts`). This middleware records HTTP request lifecycle metadata, performance metrics, request/response payload sizes, and developer authentication context in a structured JSON payload emitted via the `billing` channel child logger.

## Log Schema

Each log entry is emitted as a JSON object on completion of the HTTP request (`finish` or `close` event):

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `req-id` | `string` | Canonical request correlation ID (aliases `requestId`) |
| `requestId` | `string` | Unique request identifier (from `req.id`, `x-request-id`, or generated UUID) |
| `correlationId` | `string` | End-to-end correlation ID (from `x-correlation-id`, `x-request-id`, or `requestId`) |
| `method` | `string` | HTTP method (`GET`, `POST`, etc.) |
| `path` | `string` | Request URL path |
| `status` | `number` | HTTP response status code |
| `statusCode` | `number` | Dual field for status code compatibility |
| `latency` | `number` | Request duration in milliseconds (3 decimal places) |
| `latencyMs` | `number` | Dual field for latency in milliseconds |
| `ms` | `number` | Request duration in milliseconds |
| `durationMs` | `number` | Request duration in milliseconds |
| `size` | `number` | Response body size in bytes (aliases `responseBytes`) |
| `responseBytes` | `number` | Size of HTTP response body written in bytes |
| `requestBytes` | `number` | Size of HTTP request body in bytes |
| `actor` | `string` (optional) | Authenticated user ID or developer ID associated with the request |
| `userId` | `string` (optional) | Authenticated user ID (from `res.locals.authenticatedUser`) |
| `clientIp` | `string` (optional) | Originating client IP address (honours `TRUST_PROXY_HEADERS`) |
| `apiId` | `string` (optional) | Target API ID from billing request payload |
| `endpointId` | `string` (optional) | Target endpoint ID from billing request payload |
| `apiKeyId` | `string` (optional) | API key ID from billing request payload |
| `amountUsdc` | `string` (optional) | Deduction amount in USDC from billing request payload |
| `billingRequestId` | `string` (optional) | Client-provided deduction request ID from payload |

## Example Log Payload

```json
{
  "level": 30,
  "time": 1785178800000,
  "channel": "billing",
  "correlationId": "req-98765",
  "requestId": "req-98765",
  "req-id": "req-98765",
  "method": "POST",
  "path": "/api/billing/deduct",
  "status": 200,
  "statusCode": 200,
  "ms": 12.345,
  "durationMs": 12.345,
  "latency": 12.345,
  "latencyMs": 12.345,
  "requestBytes": 128,
  "responseBytes": 84,
  "size": 84,
  "userId": "dev_user_001",
  "actor": "dev_user_001",
  "clientIp": "192.168.1.100",
  "apiId": "api_weather",
  "endpointId": "ep_forecast",
  "apiKeyId": "ak_12345",
  "amountUsdc": "0.05",
  "billingRequestId": "client_deduct_99",
  "msg": "billing request completed"
}
```

## Security & Sensitive Field Redaction

Field redaction can be configured via `BillingAccessLogOptions.redactFields`. Any field matching configured names (case-insensitive) is replaced with `'[REDACTED]'`.

## Export Locations

The middleware and types are exported from both:
- `src/middleware/billingAccessLog.ts`
- `src/middleware/accessLog.ts`
