import { envSchema } from './env.js';

const required = { JWT_SECRET: 'test-secret', ADMIN_API_KEY: 'test-admin', METRICS_API_KEY: 'test-metrics' };
describe('idempotency lease configuration', () => {
  it('defaults to sixty seconds, above the default proxy timeout', () => {
    const parsed = envSchema.parse(required);
    expect(parsed.IDEMPOTENCY_LEASE_SECONDS).toBe(60);
    expect(parsed.IDEMPOTENCY_LEASE_SECONDS * 1000).toBeGreaterThan(parsed.PROXY_TIMEOUT_MS);
  });
  it('accepts an explicit lease independently of completed-response retention', () => {
    const parsed = envSchema.parse({ ...required, IDEMPOTENCY_LEASE_SECONDS: '120' });
    expect(parsed.IDEMPOTENCY_LEASE_SECONDS).toBe(120);
    expect(parsed.IDEMPOTENCY_RETENTION_WINDOW_SECONDS).toBe(86400);
  });
  it.each(['0', '-1', '1.5', 'invalid'])('rejects invalid lease %s', (value) => {
    expect(envSchema.safeParse({ ...required, IDEMPOTENCY_LEASE_SECONDS: value }).success).toBe(false);
  });
  it('rejects non-positive and fractional configured cached response body caps', () => {
    expect(envSchema.safeParse({ ...required, IDEMPOTENCY_MAX_BODY_BYTES: '0' }).success).toBe(false);
    expect(envSchema.safeParse({ ...required, IDEMPOTENCY_MAX_BODY_BYTES: '1.5' }).success).toBe(false);
  });
});
