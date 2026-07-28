# Rate-limit health probe

`GET /api/rate-limit/health` reports whether the rate-limit subsystem can perform
its non-consuming probe. It is a public operational endpoint and accepts no
request body.

Authenticated clients can use `GET /api/limits/check` to peek at their own
rate-limit budget without consuming a token. It returns either `{ "status":
"ok" }` or a denial with `reason: "rate_limit_exceeded"` and `retryAfterMs`.

An operational limiter returns `200` with `status: "ok"`. If the limiter store
cannot be probed, the endpoint returns `503` with `status: "down"` and the safe
error identifier `unavailable`. The complete request and response examples are
in [the OpenAPI contract](./openapi.json).
