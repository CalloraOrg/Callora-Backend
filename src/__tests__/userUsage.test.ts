import request from 'supertest';
import { createApp } from '../app.js';
import { InMemoryUsageEventsRepository, type UsageEvent } from '../repositories/usageEventsRepository.js';
import type { AuthenticatedUser } from '../types/auth.js';

describe('GET /api/usage', () => {
  const mockUser: AuthenticatedUser = { id: 'user123' };
  const mockEvents: UsageEvent[] = [
    {
      id: 'event1',
      developerId: 'dev1',
      apiId: 'api1',
      endpoint: '/api1/endpoint1',
      userId: 'user123',
      occurredAt: new Date('2024-01-15T10:00:00Z'),
      revenue: BigInt('1000000'), // $0.01 in smallest unit
    },
    {
      id: 'event2',
      developerId: 'dev1',
      apiId: 'api1',
      endpoint: '/api1/endpoint2',
      userId: 'user123',
      occurredAt: new Date('2024-01-16T12:00:00Z'),
      revenue: BigInt('2000000'), // $0.02 in smallest unit
    },
    {
      id: 'event3',
      developerId: 'dev2',
      apiId: 'api2',
      endpoint: '/api2/endpoint1',
      userId: 'user123',
      occurredAt: new Date('2024-01-17T14:00:00Z'),
      revenue: BigInt('1500000'), // $0.015 in smallest unit
    },
    {
      id: 'event4',
      developerId: 'dev1',
      apiId: 'api1',
      endpoint: '/api1/endpoint1',
      userId: 'user456', // Different user
      occurredAt: new Date('2024-01-15T11:00:00Z'),
      revenue: BigInt('1000000'), // $0.01 in smallest unit
    },
  ];

  let usageRepo: InMemoryUsageEventsRepository;

  beforeEach(() => {
    usageRepo = new InMemoryUsageEventsRepository(mockEvents);
  });

  it('requires authentication', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .expect(401);

    expect(response.body.error).toBe('Unauthorized');
  });

  it('returns usage events for authenticated user with default period', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(response.body).toMatchObject({
      events: expect.any(Array),
      stats: {
        totalCalls: 3,
        totalSpent: '4500000', // 0.01 + 0.02 + 0.015 = 0.045
        breakdownByApi: expect.any(Array),
      },
      period: expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      }),
    });

    // Should return 3 events for user123
    expect(response.body.events).toHaveLength(3);
    
    // Check breakdown by API
    const breakdown = response.body.stats.breakdownByApi;
    const api1Breakdown = breakdown.find((b: any) => b.apiId === 'api1');
    const api2Breakdown = breakdown.find((b: any) => b.apiId === 'api2');
    
    expect(api1Breakdown).toMatchObject({
      apiId: 'api1',
      calls: 2,
      revenue: '3000000', // 0.01 + 0.02
    });
    
    expect(api2Breakdown).toMatchObject({
      apiId: 'api2',
      calls: 1,
      revenue: '1500000', // 0.015
    });
  });

  it('filters by date range', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .query({
        from: '2024-01-16T00:00:00Z',
        to: '2024-01-16T23:59:59Z',
      })
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    // Should only return events from Jan 16th
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0].id).toBe('event2');
    expect(response.body.stats.totalCalls).toBe(1);
    expect(response.body.stats.totalSpent).toBe('2000000');
  });

  it('filters by API ID', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .query({ apiId: 'api1' })
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    // Should only return events for api1
    expect(response.body.events).toHaveLength(2);
    expect(response.body.stats.totalCalls).toBe(2);
    expect(response.body.stats.totalSpent).toBe('3000000');
    
    // Check breakdown only includes api1
    expect(response.body.stats.breakdownByApi).toHaveLength(1);
    expect(response.body.stats.breakdownByApi[0].apiId).toBe('api1');
  });

  it('applies limit parameter', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .query({ limit: 2 })
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    // Should return only 2 events
    expect(response.body.events).toHaveLength(2);
    
    // Stats should still reflect all events (limit only affects events array)
    expect(response.body.stats.totalCalls).toBe(3);
  });

  it('handles only from date parameter', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .query({ from: '2024-01-16T00:00:00Z' })
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    // Should return events from Jan 16th onwards (2 events)
    expect(response.body.events).toHaveLength(2);
    expect(response.body.stats.totalCalls).toBe(2);
  });

  it('handles only to date parameter', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .query({ to: '2024-01-16T23:59:59Z' })
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    // Should return events up to Jan 16th (2 events)
    expect(response.body.events).toHaveLength(2);
    expect(response.body.stats.totalCalls).toBe(2);
  });

  it('validates date format', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .query({ from: 'invalid-date' })
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    // Should use default period when date is invalid
    expect(response.body.events).toHaveLength(3);
  });

  it('validates from is before to', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .query({
        from: '2024-01-20T00:00:00Z',
        to: '2024-01-10T00:00:00Z',
      })
      .set('Authorization', 'Bearer valid-token')
      .expect(400);

    expect(response.body.error).toBe('from must be before or equal to to');
  });

  it('validates limit parameter', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .query({ limit: 'invalid' })
      .set('Authorization', 'Bearer valid-token')
      .expect(400);

    expect(response.body.error).toBe('limit must be a non-negative integer');
  });

  it('returns empty result for user with no events', async () => {
    const app = createApp({ usageEventsRepository: new InMemoryUsageEventsRepository([]) });
    
    const response = await request(app)
      .get('/api/usage')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(response.body).toMatchObject({
      events: [],
      stats: {
        totalCalls: 0,
        totalSpent: '0',
        breakdownByApi: [],
      },
      period: expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      }),
    });
  });

  it('formats event data correctly', async () => {
    const app = createApp({ usageEventsRepository: usageRepo });
    
    const response = await request(app)
      .get('/api/usage')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    const event = response.body.events[0];
    expect(event).toMatchObject({
      id: expect.any(String),
      apiId: expect.any(String),
      endpoint: expect.any(String),
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      revenue: expect.any(String),
    });
  });
});
