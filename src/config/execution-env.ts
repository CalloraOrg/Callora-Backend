import { z } from "zod";

export const executionEnvironmentFields = {
  ROUTE_BODY_LIMITS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value || value.trim().length === 0) {
        return [];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ROUTE_BODY_LIMITS must be valid JSON: ${(error as Error).message}`,
        });
        return z.NEVER;
      }

      if (!Array.isArray(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "ROUTE_BODY_LIMITS must be a JSON array of route body-limit objects",
        });
        return z.NEVER;
      }

      return parsed.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object",
      );
    })
    .pipe(
      z.array(
        z.object({
          method: z.string().min(1),
          route: z.string().min(1),
          limit: z.string().min(1),
        }),
      ),
    )
    .default([]),

  // Security
  BCRYPT_COST_FACTOR: z.coerce.number().int().min(10).max(31).default(12),

  // Billing concurrency control
  BILLING_MAX_CONCURRENCY_PER_DEV: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
  BILLING_SEMAPHORE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300000),

  // Gateway per-API-key concurrency control.
  // The default ceiling is deliberately generous: the primary purpose is
  // observability via GET /api/admin/keys/concurrency. Operators opt into
  // enforcement by lowering KEY_MAX_CONCURRENCY_PER_KEY.
  KEY_MAX_CONCURRENCY_PER_KEY: z.coerce.number().int().positive().default(50),
  KEY_SEMAPHORE_TTL_MS: z.coerce.number().int().positive().default(300000),

  // Idempotency
  IDEMPOTENCY_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  IDEMPOTENCY_RETENTION_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(86400),
  IDEMPOTENCY_SWEEPER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false")
    .default(true),
  IDEMPOTENCY_SWEEPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  IDEMPOTENCY_SWEEPER_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(5000),
  IDEMPOTENCY_SWEEPER_TIME_BUDGET_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5000),

  // Slow query alerting
  SLOW_QUERY_ALERT_WEBHOOK_URL: z.string().url().optional(),
  SLOW_QUERY_P95_THRESHOLD_MS: z.coerce.number().positive().default(500),
  SLOW_QUERY_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300_000),
  SLOW_QUERY_DEDUP_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),

  // Usage anomaly detector (5-minute rolling baseline)
  USAGE_ANOMALY_DETECTOR_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  USAGE_ANOMALY_MULTIPLIER: z.coerce.number().positive().default(5),
  USAGE_ANOMALY_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300_000),
  USAGE_ANOMALY_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300_000),
  USAGE_ANOMALY_BASELINE_WINDOWS: z.coerce
    .number()
    .int()
    .positive()
    .default(12),
  USAGE_ANOMALY_DEDUP_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),

  // Monthly invoice job
  MONTHLY_INVOICE_JOB_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(86400000),

  // ────────────────────────────────────────────────────────────────────────
  // SLO burn-rate alerting (issue #706)
  //
  // Each entry in `SLO_ROUTE_CONFIGS` defines a per-route burn threshold
  // evaluated against a rolling 96-hour window by the SLO alerter worker.
  // At least one of `maxErrorRate` or `maxLatencyP95Ms` must be set, and
  // `method`/`route` must match the parameterised Express route label
  // emitted by `http_request_duration_seconds` (e.g. `/api/billing/deduct`
  // or `/v1/call/:apiId`).
  //
  // Implementation note: the env variable is a JSON string but the schema
  // resolves to a typed `SloRouteConfig[]`. The `transform` clause parses
  // and validates the JSON before the `pipe(z.array(...))` step enforces
  // per-entry shape (and the `refine` rejects entries missing either
  // threshold). Map to `[]` when the env var is unset or empty — there is
  // no need to also call `.default()` here because the transform already
  // covers the `undefined` case.
  // ────────────────────────────────────────────────────────────────────────
} as const;
