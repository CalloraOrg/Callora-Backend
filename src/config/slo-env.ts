import { z } from "zod";

export const sloEnvironmentFields = {
  SLO_ROUTE_CONFIGS: z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val || val.trim().length === 0) {
        return [];
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(val);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `SLO_ROUTE_CONFIGS must be valid JSON: ${(err as Error).message}`,
        });
        return z.NEVER;
      }
      if (!Array.isArray(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "SLO_ROUTE_CONFIGS must be a JSON array of route objects",
        });
        return z.NEVER;
      }
      return parsed as Array<unknown>;
    })
    .pipe(
      z.array(
        z
          .object({
            method: z.string().min(1, "method is required"),
            route: z
              .string()
              .min(1, "route is required")
              .startsWith("/", 'route must start with "/"'),
            maxErrorRate: z.number().min(0).max(1).optional(),
            maxLatencyP95Ms: z.number().positive().optional(),
          })
          .refine(
            (cfg) =>
              cfg.maxErrorRate !== undefined ||
              cfg.maxLatencyP95Ms !== undefined,
            "each SLO route config must define at least one of maxErrorRate or maxLatencyP95Ms",
          ),
      ),
    ),
  SLO_ALERT_WEBHOOK_URL: z.string().url().optional(),
  SLO_ALERT_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(300_000),
  SLO_ALERT_DEDUP_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400_000), // 24h
  SLO_ALERT_OBSERVATION_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(345_600_000), // 96h = 4 days, the slow-burn window

  // Explicit opt-in to allow the testnet passphrase when NODE_ENV=production.
  // The demo deployment sets this deliberately; every other production
  // deployment must leave it unset so a testnet/mainnet mix-up fails fast.
  ALLOW_TESTNET_IN_PRODUCTION: z
    .string()
    .transform((v) => v === "true")
    .default(false),
} as const;
