/**
 * Response schema stability test for the "export" API surface.
 *
 * The repo does not expose a literal `GET /api/export` route — the closest,
 * best-defined JSON export endpoint is `GET /api/developers/exports`
 * (src/routes/developerRoutes.ts), which lists a developer's generated
 * report exports (see src/services/reportExporter.ts). That is the target
 * of this snapshot test.
 *
 * Unlike src/routes/developerRoutes.test.ts (which asserts individual
 * field values with `toMatchObject`), this suite snapshots the *full*
 * response shape — every top-level and nested key, in order — for the
 * success response and for the standardized error envelope. `toMatchObject`
 * only fails when an expected key is missing or wrong; it would silently
 * pass if a new field were added or an existing one renamed. A Jest
 * snapshot fails on any of those, so an accidental shape change surfaces as
 * a diff in code review instead of shipping unnoticed.
 *
 * Request/response data (dates, ids, developer id) is fully deterministic
 * so the committed snapshot file is stable across runs and environments.
 */
import request from 'supertest';
import express from 'express';
import { createDeveloperRouter } from '../../src/routes/developerRoutes.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import type { Developer } from '../../src/db/schema.js';
import type { SettlementStore } from '../../src/types/developer.js';
import type { UsageStore } from '../../src/types/gateway.js';
import type { DeveloperRepository } from '../../src/repositories/developerRepository.js';
import type { ReportExporterService } from '../../src/services/reportExporter.js';

const FIXED_REQUEST_ID = '00000000-0000-4000-8000-000000000001';

const mockSettlementStore = {
  create: jest.fn(),
  updateStatus: jest.fn(),
  getDeveloperSettlements: jest.fn(),
};

const mockUsageStore = {
  record: jest.fn(),
  hasEvent: jest.fn(),
  getEvents: jest.fn(),
  getUnsettledEvents: jest.fn(),
  markAsSettled: jest.fn(),
};

const mockDeveloperRepository = {
  findByUserId: jest.fn(),
  getOrCreateByUserId: jest.fn(),
  upsertProfile: jest.fn(),
};

const mockReportExporterService = {
  listExportsForDeveloper: jest.fn(),
  getSignedUrl: jest.fn(),
};

const developer: Developer = {
  id: 1,
  user_id: 'dev-schema-test',
  name: 'Schema Test Developer',
  website: 'https://example.com',
  description: 'Fixture developer for schema stability tests',
  category: 'developer-tools',
  plan_overrides: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

const app = express();
app.use(express.json());
app.use(
  '/api/developers',
  createDeveloperRouter({
    settlementStore: mockSettlementStore as unknown as SettlementStore,
    usageStore: mockUsageStore as unknown as UsageStore,
    developerRepository: mockDeveloperRepository as unknown as DeveloperRepository,
    reportExporterService: mockReportExporterService as unknown as ReportExporterService,
  }),
);
app.use(errorHandler);

describe('GET /api/developers/exports — response schema stability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeveloperRepository.findByUserId.mockResolvedValue(developer);
    mockReportExporterService.listExportsForDeveloper.mockResolvedValue([
      {
        id: 'export-fixture-1',
        developerId: developer.user_id,
        format: 'csv',
        s3Key: 'daily-exports/dev-schema-test/2026-06-01.csv',
        exportedAt: new Date('2026-06-01T12:00:00.000Z'),
        expiresAt: new Date('2026-06-08T12:00:00.000Z'),
      },
      {
        id: 'export-fixture-2',
        developerId: developer.user_id,
        format: 'json',
        s3Key: 'daily-exports/dev-schema-test/2026-06-02.json',
        exportedAt: new Date('2026-06-02T12:00:00.000Z'),
        expiresAt: new Date('2026-06-09T12:00:00.000Z'),
      },
    ]);
    mockReportExporterService.getSignedUrl.mockReturnValue(
      'https://s3.example.test/signed-url?expires=fixture',
    );
  });

  it('matches the known success response shape', async () => {
    const res = await request(app)
      .get('/api/developers/exports')
      .set('x-user-id', developer.user_id)
      .set('x-request-id', FIXED_REQUEST_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
  });

  it('matches the known shape when the developer has no exports', async () => {
    mockReportExporterService.listExportsForDeveloper.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/developers/exports')
      .set('x-user-id', developer.user_id)
      .set('x-request-id', FIXED_REQUEST_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
  });

  it('matches the known shape when limit/offset are supplied', async () => {
    const res = await request(app)
      .get('/api/developers/exports?limit=1&offset=1')
      .set('x-user-id', developer.user_id)
      .set('x-request-id', FIXED_REQUEST_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
  });

  // Error responses go through the app-wide errorHandler, whose envelope
  // embeds `timestamp: new Date().toISOString()` — genuinely dynamic, so it
  // is matched with `expect.any(String)` rather than baked into the
  // snapshot, which would otherwise fail on every run.
  it('matches the standardized error envelope shape when unauthenticated', async () => {
    const res = await request(app)
      .get('/api/developers/exports')
      .set('x-request-id', FIXED_REQUEST_ID);

    expect(res.status).toBe(401);
    expect(res.body).toMatchSnapshot({ timestamp: expect.any(String) });
  });

  it('matches the standardized error envelope shape when no developer profile exists', async () => {
    mockDeveloperRepository.findByUserId.mockResolvedValue(undefined);

    const res = await request(app)
      .get('/api/developers/exports')
      .set('x-user-id', 'no-profile-user')
      .set('x-request-id', FIXED_REQUEST_ID);

    expect(res.status).toBe(403);
    expect(res.body).toMatchSnapshot({ timestamp: expect.any(String) });
  });

  it('matches the standardized error envelope shape for an invalid query param', async () => {
    const res = await request(app)
      .get('/api/developers/exports?limit=not-a-number')
      .set('x-user-id', developer.user_id)
      .set('x-request-id', FIXED_REQUEST_ID);

    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot({ timestamp: expect.any(String) });
  });

  it('always returns the same top-level key set for a success response, regardless of row count', async () => {
    const res = await request(app)
      .get('/api/developers/exports')
      .set('x-user-id', developer.user_id);

    expect(Object.keys(res.body).sort()).toEqual(['data', 'pagination']);
    expect(Object.keys(res.body.pagination).sort()).toEqual(['limit', 'offset', 'total']);
    for (const item of res.body.data) {
      expect(Object.keys(item).sort()).toEqual(
        ['downloadUrl', 'exportedAt', 'expiresAt', 'format', 'id'].sort(),
      );
    }
  });
});
