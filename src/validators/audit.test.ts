import { auditQuerySchema } from './audit.js';

describe('auditQuerySchema', () => {
  it('should validate default query parameters successfully', () => {
    const result = auditQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it('should validate limit within valid range', () => {
    const result = auditQuerySchema.safeParse({ limit: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it('should reject non-integer limits', () => {
    const result = auditQuerySchema.safeParse({ limit: 'abc' });
    expect(result.success).toBe(false);
  });

  it('should reject out of range limits', () => {
    const result = auditQuerySchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);

    const result2 = auditQuerySchema.safeParse({ limit: '0' });
    expect(result2.success).toBe(false);
  });

  it('should parse valid ISO date strings for from and to', () => {
    const result = auditQuerySchema.safeParse({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBeInstanceOf(Date);
      expect(result.data.to).toBeInstanceOf(Date);
    }
  });

  it('should reject invalid dates', () => {
    const result = auditQuerySchema.safeParse({ from: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('should reject if from is after to', () => {
    const result = auditQuerySchema.safeParse({
      from: '2026-06-30T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('should trim string filters', () => {
    const result = auditQuerySchema.safeParse({
      event: '  LIST_USERS   ',
      actor: ' admin ',
      tenant_id: '  tenant1  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event).toBe('LIST_USERS');
      expect(result.data.actor).toBe('admin');
      expect(result.data.tenant_id).toBe('tenant1');
    }
  });
});
