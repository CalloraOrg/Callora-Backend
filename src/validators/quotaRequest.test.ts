import { describe, it, expect } from '@jest/globals';
import { quotaRequestSchema } from './quotaRequest.js';

const valid = { requested_tier: 'pro', reason: 'Need more capacity for production traffic' };

describe('quotaRequestSchema', () => {
  it.each(['free', 'pro', 'enterprise'])('accepts the %s tier', requested_tier => {
    const input = { ...valid, requested_tier };
    expect(quotaRequestSchema.parse(input)).toEqual(input);
  });

  it('accepts optional positive integer quota overrides', () => {
    for (const requested_overrides of [undefined, {}, { monthly_call_limit: 100 }, { rate_limit_max_requests: 1 }]) {
      const input = { ...valid, requested_overrides };
      expect(quotaRequestSchema.parse(input)).toEqual(input);
    }
  });

  it('requires a supported tier and a reason', () => {
    for (const requested_tier of [undefined, '', 'premium', 1]) {
      const result = quotaRequestSchema.safeParse({ ...valid, requested_tier });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map(issue => issue.path)).toContainEqual(['requested_tier']);
    }
    const missingReason = quotaRequestSchema.safeParse({ requested_tier: 'pro' });
    expect(missingReason.success).toBe(false);
    expect(missingReason.error?.issues.map(issue => issue.path)).toContainEqual(['reason']);
  });

  it('enforces the documented reason length boundaries', () => {
    for (const length of [10, 1000]) {
      expect(quotaRequestSchema.safeParse({ ...valid, reason: 'x'.repeat(length) }).success).toBe(true);
    }
    for (const length of [0, 9, 1001]) {
      const result = quotaRequestSchema.safeParse({ ...valid, reason: 'x'.repeat(length) });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map(issue => issue.path)).toContainEqual(['reason']);
    }
  });

  it('rejects invalid values independently for each quota override', () => {
    for (const field of ['monthly_call_limit', 'rate_limit_max_requests']) {
      for (const value of [0, -1, 1.5, '100', null]) {
        const result = quotaRequestSchema.safeParse({ ...valid, requested_overrides: { [field]: value } });
        expect(result.success).toBe(false);
        expect(result.error?.issues.map(issue => issue.path)).toContainEqual(['requested_overrides', field]);
      }
    }
  });

  it('does not forward unknown fields to persistence', () => {
    const result = quotaRequestSchema.parse({
      ...valid,
      admin: true,
      requested_overrides: { monthly_call_limit: 100, unknownOverride: 200 },
    });
    expect(result).toEqual({ ...valid, requested_overrides: { monthly_call_limit: 100 } });
  });
});
