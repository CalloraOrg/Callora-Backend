import { describe, expect, test } from '@jest/globals';
import { apiRegistrationSchema } from './apiRegistration.js';

describe('apiRegistrationSchema', () => {
  test('accepts a valid API registration payload', () => {
    const result = apiRegistrationSchema.safeParse({
      name: 'Weather API',
      description: 'Forecasting endpoints',
      base_url: 'https://api.weather.example.com',
      category: 'weather',
      endpoints: [
        {
          path: '/forecast',
          method: 'GET',
          price_per_call_usdc: '0.01',
          description: 'Daily forecast',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  test('rejects unsupported HTTP methods', () => {
    const result = apiRegistrationSchema.safeParse({
      name: 'Weather API',
      base_url: 'https://api.weather.example.com',
      category: 'weather',
      endpoints: [
        {
          path: '/forecast',
          method: 'FETCH',
          price_per_call_usdc: '0.01',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['endpoints', 0, 'method']);
  });

  test('rejects non-decimal price strings', () => {
    const result = apiRegistrationSchema.safeParse({
      name: 'Weather API',
      base_url: 'https://api.weather.example.com',
      category: 'weather',
      endpoints: [
        {
          path: '/forecast',
          method: 'GET',
          price_per_call_usdc: '-0.01',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['endpoints', 0, 'price_per_call_usdc']);
  });

  test('requires at least one endpoint', () => {
    const result = apiRegistrationSchema.safeParse({
      name: 'Weather API',
      base_url: 'https://api.weather.example.com',
      category: 'weather',
      endpoints: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['endpoints']);
  });
});
