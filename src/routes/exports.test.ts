import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { createExportsRouter } from './exports.js';
import { InMemoryExportStore, ReportExporterService } from '../services/reportExporter.js';
import { HmacObjectStorageClient } from '../services/scheduledExports.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import type { Developer } from '../db/schema.js';

// Test setup
const exportStore = new InMemoryExportStore();
const objectStorageClient = new HmacObjectStorageClient();
const usageEventsRepository = { getEvents: async () => [] };
const reportExporterService = new ReportExporterService(
  usageEventsRepository,
  objectStorageClient,
  exportStore,
  {
    s3Bucket: 'test-bucket',
    s3Endpoint: 'https://s3.test',
    s3SecretAccessKey: 'test-secret',
  }
);

// Mock developer repository for testing
const mockDeveloperRepository: DeveloperRepository = {
  findByUserId: jest.fn(),
  getOrCreateByUserId: jest.fn(),
  upsertProfile: jest.fn(),
};

// Helper to create a mock developer
function createMockDeveloper(userId: string): Developer {
  return {
    id: 1,
    user_id: userId,
    name: 'Test Developer',
    website: null,
    description: null,
    category: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as Developer;
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/exports', createExportsRouter({ reportExporterService, developerRepository: mockDeveloperRepository }));
  app.use(errorHandler);
  return app;
}

describe('GET /api/exports', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Clear the export store before each test
    // Access the internal records map and clear it
    // Note: This is a workaround for the InMemoryExportStore not having a clear method
    (exportStore as any).records?.clear();
    
    // Mock a developer profile for user-1
    mockDeveloperRepository.findByUserId.mockImplementation((userId: string) => {
      if (userId === 'user-1') {
        return Promise.resolve(createMockDeveloper(userId));
      }
      return Promise.resolve(undefined);
    });
  });

  it('should return 401 when not authenticated', async () => {
    const app = createTestApp();
    const response = await request(app).get('/api/exports');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should return 403 when user has no developer profile', async () => {
    const app = createTestApp();
    // Mock findByUserId to return undefined for this user
    mockDeveloperRepository.findByUserId.mockImplementationOnce((userId: string) => {
      return Promise.resolve(undefined);
    });
    const response = await request(app)
      .get('/api/exports')
      .set('x-user-id', 'user-no-profile');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('DEVELOPER_NOT_FOUND');
  });

  it('should return 200 with empty data when no exports exist', async () => {
    const app = createTestApp();
    const response = await request(app)
      .get('/api/exports')
      .set('x-user-id', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.pagination).toBeDefined();
  });

  it('should return 200 with export records when they exist', async () => {
    const app = createTestApp();
    
    // Add a test export record for user-1 with future dates
    const exportedAt = new Date('2026-07-01T00:00:00.000Z');
    const expiresAt = new Date('2026-07-28T00:00:00.000Z'); // 27 days from exportedAt (more than 7 days in the future)
    await exportStore.save({
      id: 'export-1',
      developerId: 'user-1',
      format: 'csv',
      s3Key: 'daily-exports/dev-1/2026-07-01.csv',
      exportedAt,
      expiresAt,
    });

    const response = await request(app)
      .get('/api/exports')
      .set('x-user-id', 'user-1');
    
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBe(1);
    expect(response.body.data[0].id).toBe('export-1');
    expect(response.body.data[0].format).toBe('csv');
    expect(response.body.data[0].developerId).toBe('user-1');
    expect(response.body.data[0].exportedAt).toBe(exportedAt.toISOString());
    expect(response.body.data[0].expiresAt).toBe(expiresAt.toISOString());
    expect(response.body.data[0].downloadUrl).toContain('expires=');
    expect(response.body.data[0].downloadUrl).toContain('signature=');
  });

  it('should filter by format when specified', async () => {
    const app = createTestApp();
    
    // Add CSV export with future dates
    await exportStore.save({
      id: 'export-csv',
      developerId: 'user-1',
      format: 'csv',
      s3Key: 'daily-exports/dev-1/2026-07-01.csv',
      exportedAt: new Date('2026-07-01'),
      expiresAt: new Date('2026-07-28'),
    });
    
    // Add JSON export with future dates
    await exportStore.save({
      id: 'export-json',
      developerId: 'user-1',
      format: 'json',
      s3Key: 'daily-exports/dev-1/2026-07-01.json',
      exportedAt: new Date('2026-07-01'),
      expiresAt: new Date('2026-07-28'),
    });

    // Request only CSV exports
    const response = await request(app)
      .get('/api/exports?format=csv')
      .set('x-user-id', 'user-1');
    
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBe(1);
    expect(response.body.data[0].format).toBe('csv');
  });

  it('should respect pagination parameters', async () => {
    const app = createTestApp();
    
    // Add multiple export records with future dates
    for (let i = 0; i < 5; i++) {
      await exportStore.save({
        id: `export-${i}`,
        developerId: 'user-1',
        format: 'csv',
        s3Key: `daily-exports/dev-1/2026-07-${i+1}.csv`,
        exportedAt: new Date(`2026-07-${i+1}`),
        expiresAt: new Date(`2026-07-${i+28}`), // 27 days later
      });
    }

    // Request with limit=3
    const response = await request(app)
      .get('/api/exports?limit=3')
      .set('x-user-id', 'user-1');
    
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBe(3);
    expect(response.body.pagination.limit).toBe(3);
    expect(response.body.pagination.offset).toBe(0);
  });

  it('should have standardized error envelope', async () => {
    const app = createTestApp();
    const response = await request(app).get('/api/exports');
    expect(response.body).toHaveProperty('error');
    expect(response.body.error).toHaveProperty('code');
    expect(response.body.error).toHaveProperty('message');
    expect(response.body).toHaveProperty('requestId');
    expect(response.body).toHaveProperty('success');
    expect(response.body.success).toBe(false);
  });

  describe('security headers', () => {
    const expectedCsp = "default-src 'self'; frame-ancestors 'none'; object-src 'none'";

    it('sets CSP, X-Content-Type-Options, and Referrer-Policy on 200 responses', async () => {
      const app = createTestApp();
      const response = await request(app)
        .get('/api/exports')
        .set('x-user-id', 'user-1');

      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).toBe(expectedCsp);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });

    it('sets the same security headers on 401 error responses', async () => {
      const app = createTestApp();
      const response = await request(app).get('/api/exports');

      expect(response.status).toBe(401);
      expect(response.headers['content-security-policy']).toBe(expectedCsp);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });

    it('sets the same security headers on 403 error responses', async () => {
      const app = createTestApp();
      mockDeveloperRepository.findByUserId.mockResolvedValueOnce(undefined);

      const response = await request(app)
        .get('/api/exports')
        .set('x-user-id', 'user-no-profile');

      expect(response.status).toBe(403);
      expect(response.headers['content-security-policy']).toBe(expectedCsp);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });
  });
});
