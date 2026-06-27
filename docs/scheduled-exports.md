# Scheduled usage event exports

This feature adds developer-managed recurring exports of `usage_events` to a user-provided S3-compatible endpoint.

## API

- `GET /api/exports/schedules`
- `POST /api/exports/schedules`
- `PATCH /api/exports/schedules/:scheduleId`

## Behavior

- Schedule definitions persist in the configured store.
- Worker checks for due schedules and runs them on an interval.
- Each run uploads both CSV and JSON artifacts.
- Response payloads expose signed download URLs for generated artifacts.
- Secrets are redacted from API responses.
- Errors use the standard `{ code, message, requestId }` envelope.
- Logging includes correlation identifiers via request/worker context.

## Notes

The included object storage client is an abstraction suitable for S3-compatible backends. In production, replace it with a concrete AWS Signature V4 client or SDK-backed adapter.
