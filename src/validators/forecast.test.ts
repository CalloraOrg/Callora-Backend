import {
  listForecastQuerySchema,
  forecastParamsSchema,
  createForecastSchema,
  updateForecastSchema,
  FORECAST_DEFAULT_LIMIT,
  FORECAST_MAX_LIMIT,
} from './forecast.js';

describe('Forecast Validators', () => {
  describe('listForecastQuerySchema', () => {
    it('uses default limit when limit is undefined', () => {
      const result = listForecastQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(FORECAST_DEFAULT_LIMIT);
      }
    });

    it('uses default limit when limit is empty string', () => {
      const result = listForecastQuerySchema.safeParse({ limit: '  ' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(FORECAST_DEFAULT_LIMIT);
      }
    });

    it('parses valid numeric string limit', () => {
      const result = listForecastQuerySchema.safeParse({ limit: '15' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(15);
      }
    });

    it('parses valid number limit', () => {
      const result = listForecastQuerySchema.safeParse({ limit: 30 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(30);
      }
    });

    it('caps limit at FORECAST_MAX_LIMIT', () => {
      const result = listForecastQuerySchema.safeParse({ limit: '200' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(FORECAST_MAX_LIMIT);
      }
    });

    it('fails on non-integer limit', () => {
      const result = listForecastQuerySchema.safeParse({ limit: '12.5' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('limit must be a positive integer');
      }
    });

    it('fails on non-positive integer limit', () => {
      const result = listForecastQuerySchema.safeParse({ limit: '0' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('limit must be a positive integer');
      }
    });

    it('fails on invalid string limit', () => {
      const result = listForecastQuerySchema.safeParse({ limit: 'invalid' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('limit must be a positive integer');
      }
    });

    it('passes optional cursor string', () => {
      const result = listForecastQuerySchema.safeParse({ cursor: 'fc:10' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cursor).toBe('fc:10');
      }
    });
  });

  describe('forecastParamsSchema', () => {
    it('validates a valid non-empty forecast ID parameter', () => {
      const result = forecastParamsSchema.safeParse({ id: 'forecast_123' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('forecast_123');
      }
    });

    it('fails on empty string ID parameter', () => {
      const result = forecastParamsSchema.safeParse({ id: '   ' });
      expect(result.success).toBe(false);
    });
  });

  describe('createForecastSchema', () => {

    it('validates a valid create forecast payload', () => {
      const result = createForecastSchema.safeParse({
        name: '  Sales Forecast  ',
        description: '  Q3 Projection  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('Sales Forecast');
        expect(result.data.description).toBe('Q3 Projection');
      }
    });

    it('fails when name is missing or empty', () => {
      const result = createForecastSchema.safeParse({
        name: '   ',
        description: 'Valid description',
      });
      expect(result.success).toBe(false);
    });

    it('fails when name exceeds 255 characters', () => {
      const result = createForecastSchema.safeParse({
        name: 'a'.repeat(256),
        description: 'Valid description',
      });
      expect(result.success).toBe(false);
    });

    it('fails when description exceeds 1000 characters', () => {
      const result = createForecastSchema.safeParse({
        name: 'Valid Name',
        description: 'd'.repeat(1001),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('updateForecastSchema', () => {
    it('validates updating name only', () => {
      const result = updateForecastSchema.safeParse({ name: 'Updated Name' });
      expect(result.success).toBe(true);
    });

    it('validates updating description only', () => {
      const result = updateForecastSchema.safeParse({ description: 'Updated Description' });
      expect(result.success).toBe(true);
    });

    it('fails when no fields are provided', () => {
      const result = updateForecastSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('At least one field must be provided');
      }
    });
  });
});
