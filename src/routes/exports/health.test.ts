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
import {
  createExportsHealthRouter,
  deriveOverallStatus,
  log,
  probeDatabase,
  probeStorage,
  probeQueue,
  probeNotificationApi,
  ProbeResult,
  ProbeRegistry,
} from './health.js';

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
// Default probe stubs — verify they resolve to 'ok' (no real I/O yet)
// ---------------------------------------------------------------------------

describe('default probe stubs', () => {
  it('probeDatabase resolves with status "ok"', async () => {
    const result = await probeDatabase();
    expect(result.name).toBe('database');
    expect(result.status).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('probeStorage resolves with status "ok"', async () => {
    const result = await probeStorage();
    expect(result.name).toBe('storage');
    expect(result.status).toBe('ok');
  });

  it('probeQueue resolves with status "ok"', async () => {
    const result = await probeQueue();
    expect(result.name).toBe('queue');
    expect(result.status).toBe('ok');
  });

  it('probeNotificationApi resolves with status "ok"', async () => {
    const result = await probeNotificationApi();
    expect(result.name).toBe('notificationApi');
    expect(result.status).toBe('ok');
  });
});
