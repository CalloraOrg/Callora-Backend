import client from 'prom-client';

const billingDeductDuration = new client.Histogram({
  name: 'billing_deduct_duration_seconds',
  help: 'Latency of POST /api/billing/deduct in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const refreshTokenDuration = new client.Histogram({
  name: 'refresh_token_duration_seconds',
  help: 'Latency of POST /api/refresh-token in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const creditsDuration = new client.Histogram({
  name: 'credits_duration_seconds',
  help: 'Latency of GET /api/billing/credits in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});


export function recordBillingDeductDuration(statusCode: number, durationMs: number): void {
  billingDeductDuration.observe(
    { route: '/api/billing/deduct', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function recordRefreshTokenDuration(statusCode: number, durationMs: number): void {
  refreshTokenDuration.observe(
    { route: '/api/refresh-token', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function recordCreditsDuration(statusCode: number, durationMs: number): void {
  creditsDuration.observe(
    { route: '/api/billing/credits', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function resetBillingDeductMetrics(): void {
  billingDeductDuration.reset();
}

export function resetRefreshTokenMetrics(): void {
  refreshTokenDuration.reset();
}

// ── Subscriptions latency histogram (FWC26 issue #742) ─────────────────────
//
// Metric: subscriptions_request_duration_seconds
//   Type:    Histogram
//   Labels:  route, method, status_code
//   Buckets: 1 ms → 10 s (tuned for full in-process subscription operations)
//
// Captures latency for all /api/subscriptions routes (POST, GET, PATCH, DELETE)
// with explicit bucket boundaries for percentile aggregation.
// ───────────────────────────────────────────────────────────────────────────

const subscriptionsLatencyDuration = new client.Histogram({
  name: 'subscriptions_request_duration_seconds',
  help: 'Latency of /api/subscriptions requests in seconds (FWC26 #742)',
  labelNames: ['route', 'method', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * Record a latency observation for a /api/subscriptions request.
 * Called by the timing middleware in subscriptionRoutes.ts.
 *
 * @param method     – HTTP verb (GET, POST, PATCH, DELETE)
 * @param statusCode – Response HTTP status code
 * @param durationMs – Request duration in milliseconds
 */
export function recordSubscriptionsLatency(
  method: string,
  statusCode: number,
  durationMs: number,
): void {
  subscriptionsLatencyDuration.observe(
    {
      route: '/api/subscriptions',
      method: method.toUpperCase(),
      status_code: String(statusCode),
    },
    durationMs / 1000,
  );
}

/** Reset all subscriptions histogram observations. Used in tests. */
export function resetSubscriptionsMetrics(): void {
  subscriptionsLatencyDuration.reset();
}

const maintenanceDuration = new client.Histogram({
  name: 'maintenance_duration_seconds',
  help: 'Latency of GET /api/maintenance in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function recordMaintenanceDuration(statusCode: number, durationMs: number): void {
  maintenanceDuration.observe(
    { route: '/api/maintenance', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function resetMaintenanceMetrics(): void {
  maintenanceDuration.reset();
}

const adminDuration = new client.Histogram({
  name: 'admin_duration_seconds',
  help: 'Latency of /api/admin routes in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function recordAdminDuration(route: string, statusCode: number, durationMs: number): void {
  adminDuration.observe(
    { route, status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function resetAdminMetrics(): void {
  adminDuration.reset();
}

const apisLatencyDuration = new client.Histogram({
  name: 'apis_request_duration_seconds',
  help: 'Latency of /api/apis requests in seconds (FWC26 #893)',
  labelNames: ['route', 'method', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function recordApisLatency(
  method: string,
  statusCode: number,
  durationMs: number,
): void {
  apisLatencyDuration.observe(
    {
      route: '/api/apis',
      method: method.toUpperCase(),
      status_code: String(statusCode),
    },
    durationMs / 1000,
  );
}

export function resetApisMetrics(): void {
  apisLatencyDuration.reset();
}

export {
  billingDeductDuration,
  refreshTokenDuration,
  maintenanceDuration,
  creditsDuration,
  adminDuration,
  subscriptionsLatencyDuration,
  apisLatencyDuration,
};

