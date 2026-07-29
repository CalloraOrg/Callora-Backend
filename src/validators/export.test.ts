import { exportsQuerySchema } from './export.js';

describe('exportsQuerySchema', () => {
  it('should apply default values for limit and offset', () => {
    const result = exportsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
    }
  });

  it('should parse valid limit and offset strings', () => {
    const result = exportsQuerySchema.safeParse({ limit: '50', offset: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(10);
    }
  });

  it('should clamp limit between 1 and 100', () => {
    const tooLow = exportsQuerySchema.safeParse({ limit: '0' });
    expect(tooLow.success).toBe(true);
    if (tooLow.success) {
      expect(tooLow.data.limit).toBe(1);
    }

    const tooHigh = exportsQuerySchema.safeParse({ limit: '200' });
    expect(tooHigh.success).toBe(true);
    if (tooHigh.success) {
      expect(tooHigh.data.limit).toBe(100);
    }
  });

  it('should reject non-integer limit strings', () => {
    const result = exportsQuerySchema.safeParse({ limit: 'abc' });
    expect(result.success).toBe(false);
  });

  it('should reject negative offset', () => {
    const result = exportsQuerySchema.safeParse({ offset: '-5' });
    expect(result.success).toBe(false);
  });

  it('should accept valid format values', () => {
    const csv = exportsQuerySchema.safeParse({ format: 'csv' });
    expect(csv.success).toBe(true);

    const json = exportsQuerySchema.safeParse({ format: 'json' });
    expect(json.success).toBe(true);
  });

  it('should reject invalid format values', () => {
    const result = exportsQuerySchema.safeParse({ format: 'xml' });
    expect(result.success).toBe(false);
  });

  it('should accept valid developerId', () => {
    const result = exportsQuerySchema.safeParse({ developerId: 'dev-123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.developerId).toBe('dev-123');
    }
  });

  it('should trim developerId', () => {
    const result = exportsQuerySchema.safeParse({ developerId: '  dev-123  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.developerId).toBe('dev-123');
    }
  });

  it('should reject empty developerId', () => {
    const result = exportsQuerySchema.safeParse({ developerId: '' });
    expect(result.success).toBe(false);
  });

  it('should accept all optional fields together', () => {
    const result = exportsQuerySchema.safeParse({
      limit: '30',
      offset: '5',
      developerId: 'dev-abc',
      format: 'json',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(30);
      expect(result.data.offset).toBe(5);
      expect(result.data.developerId).toBe('dev-abc');
      expect(result.data.format).toBe('json');
    }
  });
});