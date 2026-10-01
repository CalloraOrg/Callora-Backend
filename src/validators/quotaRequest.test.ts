import { describe, it, expect } from 'vitest';
import { quotaRequestSchema } from './quotaRequest';

describe('quotaRequestSchema', () => {
  describe('valid payloads', () => {
    it('parses a valid payload to the expected type', () => {
      const input = {
        requestedQuota: 100,
        reason: 'Need more capacity for production traffic',
      };

      const result = quotaRequestSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(input);
        expect(typeof result.data.requestedQuota).toBe('number');
        expect(typeof result.data.reason).toBe('string');
      }
    });

    it('accepts a positive integer quota', () => {
      const result = quotaRequestSchema.safeParse({ requestedQuota: 1, reason: 'minimal' });
      expect(result.success).toBe(true);
    });
  });

  describe('requestedQuota bounds', () => {
    it('rejects a zero quota', () => {
      const result = quotaRequestSchema.safeParse({
        requestedQuota: 0,
        reason: 'zero is not allowed',
      });

      expect(result.success).toBe(false);
    });

    it('rejects a negative quota', () => {
      const result = quotaRequestSchema.safeParse({
        requestedQuota: -10,
        reason: 'negative is not allowed',
      });

      expect(result.success).toBe(false);
    });

    it('rejects a non-integer quota', () => {
      const result = quotaRequestSchema.safeParse({
        requestedQuota: 1.5,
        reason: 'fractional quotas are not allowed',
      });

      expect(result.success).toBe(false);
    });

    it('rejects an absurdly large quota', () => {
      const result = quotaRequestSchema.safeParse({
        requestedQuota: Number.MAX_SAFE_INTEGER,
        reason: 'way too large',
      });

      expect(result.success).toBe(false);
    });

    it('rejects a non-numeric quota', () => {
      const result = quotaRequestSchema.safeParse({
        requestedQuota: '100' as unknown as number,
        reason: 'string is not a number',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('required fields', () => {
    it('rejects a missing requestedQuota with a specific message', () => {
      const result = quotaRequestSchema.safeParse({
        reason: 'missing quota',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path[0] === 'requestedQuota',
        );
        expect(issue).defined();
        expect(issue?.message).toMatch(/required/i);
      }
    });

    it('rejects a missing reason with a specific message', () => {
      const result = quotaRequestSchema.safeParse({
        requestedQuota: 100,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path[0] === 'reason');
        expect(issue).defined();
        expect(issue?.message).toMatch(/required/i);
      }
    });

    it('rejects an empty object', () => {
      const result = quotaRequestSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects an empty reason string', () => {
      const result = quotaRequestSchema.safeParse({
        requestedQuota: 100,
        reason: '',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('unknown keys', () => {
    it('strips or rejects unknown keys per schema', () => {
      const result = quotaRequestSchema.safeParse({
        requestedQuota: 100,
        reason: 'valid reason',
        unknownKey: 'unknown value',
      });

      if (result.success) {
        expect(result.data).not.toHaveProperty('unknownKey');
      } else {
        expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
      }
    });
  });
});
