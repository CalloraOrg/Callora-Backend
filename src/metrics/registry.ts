import client from 'prom-client';

const billingDeductDuration = new client.Histogram({
  name: 'billing_deduct_duration_seconds',
  help: 'Latency of POST /api/billing/deduct in seconds',
  labelNames: ['route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export function recordBillingDeductDuration(statusCode: number, durationMs: number): void {
  billingDeductDuration.observe(
    { route: '/api/billing/deduct', status_code: String(statusCode) },
    durationMs / 1000,
  );
}

export function resetBillingDeductMetrics(): void {
  billingDeductDuration.reset();
}

export { billingDeductDuration };
