/**
 * @file health.test.ts
 * @description Unit and integration tests for GET /api/exports/health.
 *
 * Coverage targets (≥ 90% on changed lines):
 *  1. All external dependencies healthy → 200 OK with full status payload.
 *  2. One or more dependencies fail / time out → 503 with failure details.
 *  3. Structured logging and correlation ID propagation.
 *
 * Probe functions are injected via the ProbeRegistry so tests never touch
 * real infrastructure.
 */

import request from 'supertest';
import express from 'express';

jest.mock('../../db.js', () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('../../config/index.js', () => ({
  config: {
    nodeEnv: 'test',
    database: {
      timeout: 2_000,
    },
    exports: {
      enabled: false,
      bucket: undefined,
      endpoint: undefined,
      region: undefined,
      signingSecret: undefined,
      endpointAllowlist: [],
      notificationHealthUrl: undefined,
    },
  },
}));

import { pool } from '../../db.js';
import { config } from '../../config/index.js';
import {
  createExportsHealthRouter,
  deriveOverallStatus,
  log,
  probeDatabase,
  probeStorage,
  probeQueue,
  probeNotificationApi,
  sanitizeDetail,
  DB_DEGRADED_THRESHOLD_MS,
  ProbeResult,
  ProbeRegistry,
} from './health.js';
import {
  createReportExporterWorker,
  InMemoryExportStore,
  ReportExporterService,
} from '../../services/reportExporter.js';
import {
  createScheduledExportsWorker,
  HmacObjectStorageClient,
  InMemoryScheduleStore,
  ScheduledExportsService,
  type ExportWorkerStatus,
} from '../../services/scheduledExports.js';

const mockPoolQuery = pool.query as jest.Mock;
const mockConfig = config as unknown as {
  nodeEnv: string;
  database: { timeout: number };
  exports: {
    enabled: boolean;
    bucket?: string;
    endpoint?: string;
    region?: string;
    signingSecret?: string;
    endpointAllowlist: string[];
    notificationHealthUrl?: string;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal Express app that mounts the exports health router. */
function buildApp(probes: ProbeRegistry) {
  const app = express();
  app.use(express.json());
  app.use('/api/exports/health', createExportsHealthRouter(probes));
  return app;
}

/** Returns a probe stub that always resolves to `ok`. */
function okProbe(name: string): () => Promise<ProbeResult> {
  return async () => ({ name, status: 'ok', latencyMs: 1 });
}

/** Returns a probe stub that always resolves to `down` with a message. */
function downProbe(name: string, detail = 'connection refused'): () => Promise<ProbeResult> {
  return async () => ({ name, status: 'down', detail });
}

/** Returns a probe stub that always resolves to `degraded`. */
function degradedProbe(name: string): () => Promise<ProbeResult> {
  return async () => ({ name, status: 'degraded', detail: 'high latency' });
}

/** Returns a probe stub that rejects (simulates a thrown error). */
function throwingProbe(name: string): () => Promise<ProbeResult> {
  return async () => {
    throw new Error(`${name} unexpected error`);
  };
}

/** Returns a probe stub that never resolves (hangs indefinitely). */
function hangingProbe(_name: string): () => Promise<ProbeResult> {
  // Never resolves — the route's internal withTimeout() will fire first.
  return () => new Promise<ProbeResult>(() => undefined);
}

/** All-healthy registry used as a convenient baseline. */
const allOkProbes: ProbeRegistry = {
  database: okProbe('database'),
  storage: okProbe('storage'),
  queue: okProbe('queue'),
  notificationApi: okProbe('notificationApi'),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GET /api/exports/health', () => {
  // -------------------------------------------------------------------------
  // Test case 1 — All dependencies healthy
  // -------------------------------------------------------------------------
  describe('when all dependencies are healthy', () => {
    it('responds with HTTP 200', async () => {
      const res = await request(buildApp(allOkProbes)).get('/api/exports/health');
      expect(res.status).toBe(200);
    });

    it('returns overall status "ok"', async () => {
      const res = await request(buildApp(allOkProbes)).get('/api/exports/health');
      expect(res.body.overall).toBe('ok');
    });

    it('includes a result for every dependency', async () => {
      const res = await request(buildApp(allOkProbes)).get('/api/exports/health');
      const names: string[] = res.body.dependencies.map((d: ProbeResult) => d.name);
      expect(names).toEqual(
        expect.arrayContaining(['database', 'storage', 'queue', 'notificationApi']),
      );
    });

    it('marks every dependency as "ok"', async () => {
      const res = await request(buildApp(allOkProbes)).get('/api/exports/health');
      for (const dep of res.body.dependencies as ProbeResult[]) {
        expect(dep.status).toBe('ok');
      }
    });

    it('includes a checkedAt ISO timestamp', async () => {
      const before = Date.now();
      const res = await request(buildApp(allOkProbes)).get('/api/exports/health');
      const after = Date.now();
      const ts = new Date(res.body.checkedAt as string).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('includes a correlationId in the response body', async () => {
      const res = await request(buildApp(allOkProbes)).get('/api/exports/health');
      expect(typeof res.body.correlationId).toBe('string');
      expect((res.body.correlationId as string).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test case 2 — One or more dependencies fail / time out
  // -------------------------------------------------------------------------
  describe('when one dependency is down', () => {
    const partiallyDownProbes: ProbeRegistry = {
      ...allOkProbes,
      database: downProbe('database', 'ECONNREFUSED 127.0.0.1:5432'),
    };

    it('responds with HTTP 503', async () => {
      const res = await request(buildApp(partiallyDownProbes)).get('/api/exports/health');
      expect(res.status).toBe(503);
    });

    it('returns overall status "down"', async () => {
      const res = await request(buildApp(partiallyDownProbes)).get('/api/exports/health');
      expect(res.body.overall).toBe('down');
    });

    it('exposes failure detail for the failing dependency', async () => {
      const res = await request(buildApp(partiallyDownProbes)).get('/api/exports/health');
      const db = (res.body.dependencies as ProbeResult[]).find((d) => d.name === 'database');
      expect(db?.status).toBe('down');
      expect(db?.detail).toMatch(/ECONNREFUSED/);
    });

    it('still reports healthy statuses for the other dependencies', async () => {
      const res = await request(buildApp(partiallyDownProbes)).get('/api/exports/health');
      const others = (res.body.dependencies as ProbeResult[]).filter(
        (d) => d.name !== 'database',
      );
      for (const dep of others) {
        expect(dep.status).toBe('ok');
      }
    });
  });

  describe('when all dependencies are down', () => {
    const allDownProbes: ProbeRegistry = {
      database: downProbe('database'),
      storage: downProbe('storage'),
      queue: downProbe('queue'),
      notificationApi: downProbe('notificationApi'),
    };

    it('responds with HTTP 503', async () => {
      const res = await request(buildApp(allDownProbes)).get('/api/exports/health');
      expect(res.status).toBe(503);
    });

    it('returns overall status "down"', async () => {
      const res = await request(buildApp(allDownProbes)).get('/api/exports/health');
      expect(res.body.overall).toBe('down');
    });
  });

  describe('when a dependency is degraded (but none are down)', () => {
    const degradedProbes: ProbeRegistry = {
      ...allOkProbes,
      storage: degradedProbe('storage'),
    };

    it('responds with HTTP 200', async () => {
      const res = await request(buildApp(degradedProbes)).get('/api/exports/health');
      expect(res.status).toBe(200);
    });

    it('returns overall status "degraded"', async () => {
      const res = await request(buildApp(degradedProbes)).get('/api/exports/health');
      expect(res.body.overall).toBe('degraded');
    });
  });

  describe('when a probe throws an unexpected error', () => {
    const errorProbes: ProbeRegistry = {
      ...allOkProbes,
      queue: throwingProbe('queue'),
    };

    it('responds with HTTP 503', async () => {
      const res = await request(buildApp(errorProbes)).get('/api/exports/health');
      expect(res.status).toBe(503);
    });

    it('marks the failing dependency as "down" and captures the error message', async () => {
      const res = await request(buildApp(errorProbes)).get('/api/exports/health');
      const q = (res.body.dependencies as ProbeResult[]).find((d) => d.name === 'queue');
      expect(q?.status).toBe('down');
      expect(q?.detail).toMatch(/queue unexpected error/);
    });
  });

  describe('when a probe throws synchronously', () => {
    const syncThrowProbes: ProbeRegistry = {
      ...allOkProbes,
      database: (() => {
        throw new Error('sync boom postgresql://user:supersecret@db.internal:5432/callora');
      }) as () => Promise<ProbeResult>,
    };

    it('responds with HTTP 503 and sanitizes the error message', async () => {
      const res = await request(buildApp(syncThrowProbes)).get('/api/exports/health');
      expect(res.status).toBe(503);
      expect(res.body.overall).toBe('down');
      const db = (res.body.dependencies as ProbeResult[]).find((d) => d.name === 'database');
      expect(db?.status).toBe('down');
      expect(db?.detail).toContain('sync boom');
      expect(db?.detail).not.toContain('supersecret');
      expect(db?.detail).toContain('[REDACTED]');
    });
  });

  describe('when a probe hangs past the timeout', () => {
    const timeoutProbes: ProbeRegistry = {
      ...allOkProbes,
      notificationApi: hangingProbe('notificationApi'),
    };

    // The route's withTimeout guard fires after 5 s of real time.
    // We allow up to 8 s per test and use --forceExit to clean up the
    // never-resolving promise left by hangingProbe.
    it('responds with HTTP 503 after the probe times out', async () => {
      const res = await request(buildApp(timeoutProbes))
        .get('/api/exports/health')
        .timeout(8_000);
      expect(res.status).toBe(503);
    }, 8_000);

    it('marks the timed-out dependency as "down"', async () => {
      const res = await request(buildApp(timeoutProbes))
        .get('/api/exports/health')
        .timeout(8_000);
      const api = (res.body.dependencies as ProbeResult[]).find(
        (d) => d.name === 'notificationApi',
      );
      expect(api?.status).toBe('down');
      expect(api?.detail).toMatch(/timed out/i);
    }, 8_000);
  });

  // -------------------------------------------------------------------------
  // Test case 3 — Structured logging and correlation ID propagation
  // -------------------------------------------------------------------------
  describe('correlation ID propagation', () => {
    it('echoes a supplied x-correlation-id header back in the response body', async () => {
      const id = 'test-correlation-abc-123';
      const res = await request(buildApp(allOkProbes))
        .get('/api/exports/health')
        .set('x-correlation-id', id);
      expect(res.body.correlationId).toBe(id);
    });

    it('generates a UUID correlation ID when the header is absent', async () => {
      const res = await request(buildApp(allOkProbes)).get('/api/exports/health');
      // UUID v4 pattern
      expect(res.body.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('generates a UUID correlation ID when the header is an empty string', async () => {
      const res = await request(buildApp(allOkProbes))
        .get('/api/exports/health')
        .set('x-correlation-id', '');
      expect(res.body.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('structured logging', () => {
    let writeSpy: jest.SpyInstance;

    beforeEach(() => {
      writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      writeSpy.mockRestore();
    });

    it('emits at least one log entry per request', async () => {
      await request(buildApp(allOkProbes)).get('/api/exports/health');
      expect(writeSpy).toHaveBeenCalled();
    });

    it('emits valid JSON log lines', async () => {
      await request(buildApp(allOkProbes)).get('/api/exports/health');
      const calls = writeSpy.mock.calls as [string][];
      for (const [line] of calls) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('includes the correlationId in every log line', async () => {
      const id = 'logging-test-id-xyz';
      await request(buildApp(allOkProbes))
        .get('/api/exports/health')
        .set('x-correlation-id', id);

      const calls = writeSpy.mock.calls as [string][];
      for (const [line] of calls) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(entry.correlationId).toBe(id);
      }
    });

    it('includes a timestamp in every log line', async () => {
      await request(buildApp(allOkProbes)).get('/api/exports/health');
      const calls = writeSpy.mock.calls as [string][];
      for (const [line] of calls) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(typeof entry.timestamp).toBe('string');
        expect(new Date(entry.timestamp as string).getTime()).not.toBeNaN();
      }
    });

    it('includes a level field in every log line', async () => {
      await request(buildApp(allOkProbes)).get('/api/exports/health');
      const calls = writeSpy.mock.calls as [string][];
      for (const [line] of calls) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(['info', 'warn', 'error']).toContain(entry.level);
      }
    });

    it('emits warn-level log when a dependency is degraded', async () => {
      const probes: ProbeRegistry = { ...allOkProbes, storage: degradedProbe('storage') };
      await request(buildApp(probes)).get('/api/exports/health');
      const calls = writeSpy.mock.calls as [string][];
      const entries = calls.map(([line]) => JSON.parse(line) as Record<string, unknown>);
      const warnEntry = entries.find(
        (e) => e.level === 'warn' && (e.dependency as string) === 'storage',
      );
      expect(warnEntry).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for exported helpers
// ---------------------------------------------------------------------------

describe('deriveOverallStatus', () => {
  it('returns "ok" when all dependencies are ok', () => {
    const results: ProbeResult[] = [
      { name: 'a', status: 'ok' },
      { name: 'b', status: 'ok' },
    ];
    expect(deriveOverallStatus(results)).toBe('ok');
  });

  it('returns "degraded" when at least one is degraded and none are down', () => {
    const results: ProbeResult[] = [
      { name: 'a', status: 'ok' },
      { name: 'b', status: 'degraded' },
    ];
    expect(deriveOverallStatus(results)).toBe('degraded');
  });

  it('returns "down" when at least one is down', () => {
    const results: ProbeResult[] = [
      { name: 'a', status: 'ok' },
      { name: 'b', status: 'down' },
    ];
    expect(deriveOverallStatus(results)).toBe('down');
  });

  it('returns "down" when a dependency is both degraded and another is down', () => {
    const results: ProbeResult[] = [
      { name: 'a', status: 'degraded' },
      { name: 'b', status: 'down' },
    ];
    expect(deriveOverallStatus(results)).toBe('down');
  });

  it('returns "ok" for an empty results array', () => {
    expect(deriveOverallStatus([])).toBe('ok');
  });
});

describe('log helper', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('writes a newline-terminated JSON string to stdout', () => {
    log('info', 'test message', 'cid-001');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const output = (writeSpy.mock.calls[0] as [string])[0];
    expect(output.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('merges extra fields into the log entry', () => {
    log('warn', 'test warn', 'cid-002', { foo: 'bar', count: 42 });
    const output = (writeSpy.mock.calls[0] as [string])[0];
    const entry = JSON.parse(output) as Record<string, unknown>;
    expect(entry.foo).toBe('bar');
    expect(entry.count).toBe(42);
  });

  it('sets the level field correctly for each severity', () => {
    (['info', 'warn', 'error'] as const).forEach((level) => {
      writeSpy.mockClear();
      log(level, 'msg', 'cid-003');
      const output = (writeSpy.mock.calls[0] as [string])[0];
      const entry = JSON.parse(output) as Record<string, unknown>;
      expect(entry.level).toBe(level);
    });
  });
});

// ---------------------------------------------------------------------------
// sanitizeDetail helper
// ---------------------------------------------------------------------------

describe('sanitizeDetail', () => {
  afterEach(() => {
    mockConfig.exports.signingSecret = undefined;
  });

  it('redacts URL credentials, bearer tokens, sensitive query params, and signing secrets', () => {
    mockConfig.exports.signingSecret = 'top-secret-signing-key-1234567890123456';
    const raw =
      'Failed https://admin:p4ssw0rd@s3.example.com/bucket?expires=10&signature=abc123&token=xyz Bearer eyJhbGciOiJIUzI1NiJ9 top-secret-signing-key-1234567890123456';
    const sanitized = sanitizeDetail(raw);
    expect(sanitized).not.toContain('p4ssw0rd');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('xyz');
    expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(sanitized).not.toContain('top-secret-signing-key-1234567890123456');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('truncates excessively long detail strings', () => {
    const sanitized = sanitizeDetail('x'.repeat(500));
    expect(sanitized.length).toBeLessThanOrEqual(256);
    expect(sanitized.endsWith('...')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real probe implementations — success & failure paths
// ---------------------------------------------------------------------------

function resetMockConfig() {
  mockConfig.nodeEnv = 'test';
  mockConfig.database.timeout = 2_000;
  mockConfig.exports = {
    enabled: false,
    bucket: undefined,
    endpoint: undefined,
    region: undefined,
    signingSecret: undefined,
    endpointAllowlist: [],
    notificationHealthUrl: undefined,
  };
}

describe('probeDatabase', () => {
  beforeEach(() => {
    resetMockConfig();
    mockPoolQuery.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns "ok" when SELECT 1 succeeds within threshold', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const result = await probeDatabase();
    expect(mockPoolQuery).toHaveBeenCalledWith('SELECT 1');
    expect(result.name).toBe('database');
    expect(result.status).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('returns "degraded" when SELECT 1 succeeds slower than threshold', async () => {
    jest.useFakeTimers();
    mockPoolQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ rows: [{ '?column?': 1 }] }), DB_DEGRADED_THRESHOLD_MS + 200);
        }),
    );

    const probePromise = probeDatabase({ timeoutMs: 5_000, degradedThresholdMs: DB_DEGRADED_THRESHOLD_MS });
    await jest.advanceTimersByTimeAsync(DB_DEGRADED_THRESHOLD_MS + 200);
    const result = await probePromise;

    expect(result.name).toBe('database');
    expect(result.status).toBe('degraded');
    expect(result.latencyMs).toBeGreaterThan(DB_DEGRADED_THRESHOLD_MS);
    expect(result.detail).toMatch(/exceeded threshold/i);
  });

  it('returns "down" with sanitized detail when pool.query rejects', async () => {
    mockPoolQuery.mockRejectedValue(
      new Error('connect ECONNREFUSED postgresql://dbuser:dbpass@10.0.0.1:5432/callora'),
    );

    const result = await probeDatabase();
    expect(result.name).toBe('database');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/ECONNREFUSED/);
    expect(result.detail).not.toContain('dbpass');
    expect(result.latencyMs).toBeUndefined();
  });

  it('returns "down" when pool.query throws synchronously', async () => {
    mockPoolQuery.mockImplementation(() => {
      throw new Error('PostgreSQL is unavailable in demo mode');
    });

    const result = await probeDatabase();
    expect(result.name).toBe('database');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/unavailable/i);
  });

  it('returns "down" when pool.query hangs past the timeout', async () => {
    jest.useFakeTimers();
    mockPoolQuery.mockImplementation(() => new Promise(() => undefined));

    const probePromise = probeDatabase({ timeoutMs: 1_500 });
    await jest.advanceTimersByTimeAsync(1_500);
    const result = await probePromise;

    expect(result.name).toBe('database');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/timed out/i);
  });
});

describe('probeStorage', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetMockConfig();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('returns "ok" with detail "exports disabled" when exports are disabled', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeStorage();
    expect(result.name).toBe('storage');
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('exports disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns "down" when exports are enabled but storage config is incomplete', async () => {
    mockConfig.exports.enabled = true;
    mockConfig.exports.bucket = '';
    mockConfig.exports.endpoint = 'https://s3.example.com';

    const result = await probeStorage();
    expect(result.name).toBe('storage');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/incomplete/i);
  });

  it('returns "down" when storage endpoint fails validation', async () => {
    mockConfig.exports.enabled = true;
    mockConfig.exports.bucket = 'exports-bucket';
    mockConfig.exports.endpoint = 'http://127.0.0.1:9000';

    const result = await probeStorage();
    expect(result.name).toBe('storage');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/private|loopback|reserved/i);
  });

  it('returns "down" when storage endpoint uses HTTP in production', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.exports.enabled = true;
    mockConfig.exports.bucket = 'exports-bucket';
    mockConfig.exports.endpoint = 'http://s3.example.com';

    const result = await probeStorage();
    expect(result.name).toBe('storage');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/HTTPS/i);
  });

  it('returns "ok" when HEAD bucket returns 200', async () => {
    mockConfig.exports.enabled = true;
    mockConfig.exports.bucket = 'exports-bucket';
    mockConfig.exports.endpoint = 'https://s3.example.com';

    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await probeStorage({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://s3.example.com/exports-bucket',
      expect.objectContaining({ method: 'HEAD' }),
    );
    expect(result.name).toBe('storage');
    expect(result.status).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
  });

  it.each([404, 405, 400])(
    'returns "degraded" when HEAD bucket returns non-auth 4xx (%i)',
    async (status) => {
      mockConfig.exports.enabled = true;
      mockConfig.exports.bucket = 'exports-bucket';
      mockConfig.exports.endpoint = 'https://s3.example.com';

      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status });
      const result = await probeStorage({ fetchImpl: fetchMock as unknown as typeof fetch });

      expect(result.name).toBe('storage');
      expect(result.status).toBe('degraded');
      expect(result.detail).toContain(`HTTP ${status}`);
    },
  );

  it.each([401, 403])(
    'returns "down" when HEAD bucket returns auth failure (%i)',
    async (status) => {
      mockConfig.exports.enabled = true;
      mockConfig.exports.bucket = 'exports-bucket';
      mockConfig.exports.endpoint = 'https://s3.example.com';

      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status });
      const result = await probeStorage({ fetchImpl: fetchMock as unknown as typeof fetch });

      expect(result.name).toBe('storage');
      expect(result.status).toBe('down');
      expect(result.detail).toMatch(/authentication failed/i);
      expect(result.detail).toContain(`HTTP ${status}`);
    },
  );

  it('returns "down" when HEAD bucket returns 5xx', async () => {
    mockConfig.exports.enabled = true;
    mockConfig.exports.bucket = 'exports-bucket';
    mockConfig.exports.endpoint = 'https://s3.example.com';

    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const result = await probeStorage({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.name).toBe('storage');
    expect(result.status).toBe('down');
    expect(result.detail).toContain('HTTP 503');
  });

  it('returns "down" with sanitized detail when fetch rejects', async () => {
    mockConfig.exports.enabled = true;
    mockConfig.exports.bucket = 'exports-bucket';
    mockConfig.exports.endpoint = 'https://s3.example.com';
    mockConfig.exports.signingSecret = 'super-secret-export-signing-key-123456';

    const fetchMock = jest.fn().mockRejectedValue(
      new Error('fetch failed: super-secret-export-signing-key-123456'),
    );
    const result = await probeStorage({ fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.name).toBe('storage');
    expect(result.status).toBe('down');
    expect(result.detail).not.toContain('super-secret-export-signing-key-123456');
    expect(result.detail).toContain('[REDACTED]');
  });

  it('returns "down" when storage HEAD request times out', async () => {
    jest.useFakeTimers();
    mockConfig.exports.enabled = true;
    mockConfig.exports.bucket = 'exports-bucket';
    mockConfig.exports.endpoint = 'https://s3.example.com';

    const fetchMock = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const probePromise = probeStorage({
      timeoutMs: 1_000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await probePromise;

    expect(result.name).toBe('storage');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/timed out/i);
  });
});

describe('probeQueue', () => {
  beforeEach(() => {
    resetMockConfig();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeWorkerStatus(overrides: Partial<ExportWorkerStatus> = {}): ExportWorkerStatus {
    return {
      name: 'reportExporter',
      state: 'running',
      intervalMs: 60_000,
      inFlight: false,
      startedAt: new Date(),
      lastTickAt: new Date(),
      lastTickAgeMs: 100,
      lastError: null,
      ...overrides,
    };
  }

  it('returns "ok" with detail "exports disabled" when exports are disabled', async () => {
    const result = await probeQueue();
    expect(result.name).toBe('queue');
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('exports disabled');
  });

  it('returns "down" when exports are enabled and no workers are registered', async () => {
    mockConfig.exports.enabled = true;

    const result = await probeQueue({ getWorkerStatuses: () => [null, null] });
    expect(result.name).toBe('queue');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/no export workers/i);
  });

  it('returns "ok" when all workers are running and not stale', async () => {
    mockConfig.exports.enabled = true;

    const result = await probeQueue({
      getWorkerStatuses: () => [
        makeWorkerStatus({ name: 'reportExporter' }),
        makeWorkerStatus({ name: 'scheduledExports' }),
      ],
    });
    expect(result.name).toBe('queue');
    expect(result.status).toBe('ok');
  });

  it('returns "down" when a worker is stopped', async () => {
    mockConfig.exports.enabled = true;

    const result = await probeQueue({
      getWorkerStatuses: () => [
        makeWorkerStatus({ name: 'reportExporter', state: 'stopped' }),
      ],
    });
    expect(result.name).toBe('queue');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/stopped/i);
  });

  it('returns "down" when a running worker is stale', async () => {
    mockConfig.exports.enabled = true;

    const result = await probeQueue({
      getWorkerStatuses: () => [
        makeWorkerStatus({
          name: 'scheduledExports',
          state: 'running',
          intervalMs: 10_000,
          lastTickAgeMs: 25_000,
        }),
      ],
    });
    expect(result.name).toBe('queue');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/stale/i);
  });

  it('returns "degraded" when a running worker recorded a lastError', async () => {
    mockConfig.exports.enabled = true;

    const result = await probeQueue({
      getWorkerStatuses: () => [
        makeWorkerStatus({
          name: 'reportExporter',
          lastError: 'transient upload error https://u:secretpass@s3.example.com',
        }),
      ],
    });
    expect(result.name).toBe('queue');
    expect(result.status).toBe('degraded');
    expect(result.detail).not.toContain('secretpass');
    expect(result.detail).toContain('[REDACTED]');
  });

  it('integrates with live reportExporter and scheduledExports workers', async () => {
    mockConfig.exports.enabled = true;
    const reportService = new ReportExporterService(
      { getEventsInRange: async () => [] },
      new HmacObjectStorageClient(),
      new InMemoryExportStore(),
      { s3Bucket: 'b', s3Endpoint: 'https://s3.example.com', s3SecretAccessKey: 's'.repeat(32) },
    );
    const scheduledService = new ScheduledExportsService(
      { findByApiId: async () => [] },
      new InMemoryScheduleStore('encryption-key'),
      new HmacObjectStorageClient(),
    );

    const reportWorker = createReportExporterWorker(reportService, { intervalMs: 60_000 });
    const scheduledWorker = createScheduledExportsWorker(scheduledService, { intervalMs: 60_000 });

    // Before start: stopped -> down
    expect(reportWorker.getWorkerStatus().state).toBe('stopped');
    expect(scheduledWorker.getWorkerStatus().state).toBe('stopped');
    const stoppedResult = await probeQueue();
    expect(stoppedResult.status).toBe('down');

    // After start: running -> ok
    reportWorker.start();
    scheduledWorker.start();
    await Promise.all([reportWorker.awaitIdle(), scheduledWorker.awaitIdle()]);
    const runningResult = await probeQueue();
    expect(runningResult.status).toBe('ok');

    // Clean up timers
    reportWorker.stop();
    scheduledWorker.stop();
    await Promise.all([reportWorker.awaitIdle(), scheduledWorker.awaitIdle()]);
  });
});

describe('probeNotificationApi', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetMockConfig();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('returns "ok" with detail when notification health URL is unset', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await probeNotificationApi();
    expect(result.name).toBe('notificationApi');
    expect(result.status).toBe('ok');
    expect(result.detail).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns "down" when configured URL is invalid', async () => {
    const result = await probeNotificationApi({ url: 'not-a-valid-url' });
    expect(result.name).toBe('notificationApi');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/invalid/i);
  });

  it('returns "ok" when GET health URL returns 200', async () => {
    mockConfig.exports.notificationHealthUrl = 'https://notify.example.com/health';
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await probeNotificationApi({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://notify.example.com/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.name).toBe('notificationApi');
    expect(result.status).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
  });

  it.each([404, 500, 503])(
    'returns "down" when GET health URL returns non-2xx (%i)',
    async (status) => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status });
      const result = await probeNotificationApi({
        url: 'https://notify.example.com/health',
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(result.name).toBe('notificationApi');
      expect(result.status).toBe('down');
      expect(result.detail).toContain(`HTTP ${status}`);
    },
  );

  it('returns "down" with sanitized detail when fetch rejects', async () => {
    const fetchMock = jest.fn().mockRejectedValue(
      new Error('request failed Authorization Bearer super-secret-jwt-token'),
    );
    const result = await probeNotificationApi({
      url: 'https://notify.example.com/health',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.name).toBe('notificationApi');
    expect(result.status).toBe('down');
    expect(result.detail).not.toContain('super-secret-jwt-token');
    expect(result.detail).toContain('[REDACTED]');
  });

  it('returns "down" when notification API probe times out via AbortController', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const probePromise = probeNotificationApi({
      url: 'https://notify.example.com/health',
      timeoutMs: 1_000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await probePromise;

    expect(result.name).toBe('notificationApi');
    expect(result.status).toBe('down');
    expect(result.detail).toMatch(/timed out/i);
  });
});
