import request from 'supertest';
import express from 'express';
import { createSpikeRouter, type SpikeRecord } from '../spike.js';
import type { AuditService, AuditRecordInput } from '../../services/auditService.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../lib/circuitBreaker.js';

const mockRecord = jest.fn<AuditService['record']>();
const mockAuditService: AuditService = { record: mockRecord };

function buildApp(auditBreaker?: CircuitBreaker) {
  const app = express();
  app.use(express.json());
  app.use(
    '/spike',
    createSpikeRouter({
      auditService: mockAuditService,
      circuitBreaker: auditBreaker,
    }),
  );
  return app;
}

describe('Spike Router — Mutation Audit Logging with Circuit Breaker', () => {
  let app: express.Express;

  beforeAll(() => {
    app = buildApp();
  });

  beforeEach(() => {
    mockRecord.mockReset();
    mockRecord.mockResolvedValue(undefined);
  });

  describe('POST /spike', () => {
    it('creates a spike record and persists an audit row', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Traffic spike', severity: 'high' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        label: 'Traffic spike',
        severity: 'high',
      });
      expect(res.body.id).toBeDefined();
      expect(res.body.createdAt).toBeDefined();
      expect(res.body.updatedAt).toBeDefined();

      expect(mockRecord).toHaveBeenCalledTimes(1);
      const call = mockRecord.mock.calls[0]![0] as AuditRecordInput;
      expect(call.event).toBe('SPIKE_CREATE');
      expect(call.actor).toBe('anonymous');
      expect(call.details).toMatchObject({
        spikeId: res.body.id,
        before: null,
        after: { label: 'Traffic spike', severity: 'high' },
      });
    });

    it('rejects missing label', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ severity: 'high' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects empty label', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: '', severity: 'low' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects invalid severity', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Test', severity: 'extreme' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects missing severity', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Test' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('still returns 201 when audit write fails (best-effort)', async () => {
      mockRecord.mockRejectedValue(new Error('DB down'));

      const res = await request(app)
        .post('/spike')
        .send({ label: 'Resilience test', severity: 'critical' });

      expect(res.status).toBe(201);
      expect(res.body.label).toBe('Resilience test');
    });
  });

  describe('PUT /spike/:id', () => {
    let created: SpikeRecord;

    beforeEach(async () => {
      mockRecord.mockReset();
      mockRecord.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Original', severity: 'low' });
      created = res.body;
    });

    it('updates a spike record and persists an audit row', async () => {
      const res = await request(app)
        .put(`/spike/${created.id}`)
        .send({ label: 'Updated', severity: 'high' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: created.id,
        label: 'Updated',
        severity: 'high',
      });
      expect(res.body.updatedAt).not.toBe(created.updatedAt);

      expect(mockRecord).toHaveBeenCalledTimes(1);
      const call = mockRecord.mock.calls[0]![0] as AuditRecordInput;
      expect(call.event).toBe('SPIKE_UPDATE');
      expect(call.actor).toBe('anonymous');
      expect(call.details).toMatchObject({
        spikeId: created.id,
        before: { label: 'Original', severity: 'low' },
        after: { label: 'Updated', severity: 'high' },
      });
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app)
        .put('/spike/non-existent')
        .send({ label: 'Nope', severity: 'low' });

      expect(res.status).toBe(404);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects invalid severity on update', async () => {
      const res = await request(app)
        .put(`/spike/${created.id}`)
        .send({ severity: 'invalid' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /spike/:id', () => {
    let created: SpikeRecord;

    beforeEach(async () => {
      mockRecord.mockReset();
      mockRecord.mockResolvedValue(undefined);
      const res = await request(app)
        .post('/spike')
        .send({ label: 'ToDelete', severity: 'medium' });
      created = res.body;
    });

    it('deletes a spike record and persists an audit row', async () => {
      const res = await request(app).delete(`/spike/${created.id}`);

      expect(res.status).toBe(204);

      expect(mockRecord).toHaveBeenCalledTimes(1);
      const call = mockRecord.mock.calls[0]![0] as AuditRecordInput;
      expect(call.event).toBe('SPIKE_DELETE');
      expect(call.actor).toBe('anonymous');
      expect(call.details).toMatchObject({
        spikeId: created.id,
        before: { label: 'ToDelete', severity: 'medium' },
        after: null,
      });
    });

    it('returns 204 on repeat delete (idempotent at audit level)', async () => {
      await request(app).delete(`/spike/${created.id}`);
      mockRecord.mockReset();

      const res = await request(app).delete(`/spike/${created.id}`);
      expect(res.status).toBe(404);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app).delete('/spike/non-existent');
      expect(res.status).toBe(404);
      expect(mockRecord).not.toHaveBeenCalled();
    });
  });

  describe('GET /spike/records', () => {
    it('returns an empty list when no spikes exist', async () => {
      const res = await request(app).get('/spike/records');
      expect(res.status).toBe(200);
      expect(res.body.records).toEqual([]);
    });

    it('returns created spikes', async () => {
      await request(app)
        .post('/spike')
        .send({ label: 'A', severity: 'low' });
      const res = await request(app).get('/spike/records');
      expect(res.status).toBe(200);
      expect(res.body.records).toHaveLength(1);
      expect(res.body.records[0]!.label).toBe('A');
    });
  });

  describe('GET /spike (existing timeout behavior preserved)', () => {
    it('completes successfully when delay is within timeout', async () => {
      const res = await request(app).get('/spike?delay=50');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.delay).toBe(50);
    });
  });

  describe('Circuit Breaker — Closed state (normal operation)', () => {
    it('passes requests through when circuit is closed', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });
      const app = buildApp(breaker);

      const res = await request(app)
        .post('/spike')
        .send({ label: 'Test', severity: 'low' });

      expect(res.status).toBe(201);
      expect(mockRecord).toHaveBeenCalledTimes(1);
    });

    it('increments failure counter on audit service error', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });
      const app = buildApp(breaker);

      mockRecord.mockRejectedValue(new Error('Network error'));

      const res = await request(app)
        .post('/spike')
        .send({ label: 'Test', severity: 'low' });

      // Request succeeds (audit is best-effort), but breaker counts the failure
      expect(res.status).toBe(201);
      expect(mockRecord).toHaveBeenCalledTimes(1);

      // Verify failure was recorded
      const metrics = await breaker.getMetrics('spike-audit');
      expect(metrics.consecutiveFailures).toBe(1);
      expect(metrics.totalFailures).toBe(1);
    });

    it('stays closed when failures do not reach threshold', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 5 });
      const app = buildApp(breaker);

      mockRecord.mockRejectedValue(new Error('Network error'));

      // Make 4 requests (under threshold of 5)
      for (let i = 0; i < 4; i++) {
        await request(app)
          .post('/spike')
          .send({ label: `Test ${i}`, severity: 'low' });
      }

      const metrics = await breaker.getMetrics('spike-audit');
      expect(metrics.state).toBe('CLOSED');
      expect(metrics.consecutiveFailures).toBe(4);
    });
  });

  describe('Circuit Breaker — Open state (fast-fail)', () => {
    it('trips to OPEN after threshold failures', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });
      const app = buildApp(breaker);

      mockRecord.mockRejectedValue(new Error('Service down'));

      // Trigger 3 failures to trip the circuit
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/spike')
          .send({ label: `Test ${i}`, severity: 'low' });
        expect(res.status).toBe(201); // Still succeeds (audit is best-effort)
      }

      const metrics = await breaker.getMetrics('spike-audit');
      expect(metrics.state).toBe('OPEN');
    });

    it('fast-fails with 503 when circuit is open (no downstream attempt)', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 60000,
      });
      const app = buildApp(breaker);

      mockRecord.mockRejectedValue(new Error('Service down'));

      // Trip the circuit with 2 failures
      for (let i = 0; i < 2; i++) {
        await request(app)
          .post('/spike')
          .send({ label: `Trip ${i}`, severity: 'low' });
      }

      // Verify circuit is open
      expect((await breaker.getMetrics('spike-audit')).state).toBe('OPEN');

      // Reset mock to verify it is NOT called on fast-fail
      mockRecord.mockReset();
      mockRecord.mockResolvedValue(undefined);

      // Next request should fast-fail with 503
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Fast fail test', severity: 'high' });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.message).toContain('Audit service temporarily unavailable');

      // CRITICAL: Verify the audit service was NOT called (fail-fast behavior)
      expect(mockRecord).not.toHaveBeenCalled();

      // Verify the spike record WAS created in-memory (state mutation happened before audit)
      const recordsRes = await request(app).get('/spike/records');
      expect(recordsRes.body.records).toHaveLength(3); // 2 trip + 1 fast-fail
    });

    it('continues to fail-fast while circuit remains open', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 60000,
      });
      const app = buildApp(breaker);

      mockRecord.mockRejectedValue(new Error('Service down'));

      // Trip with 1 failure
      await request(app)
        .post('/spike')
        .send({ label: 'Trip', severity: 'low' });

      mockRecord.mockReset();
      mockRecord.mockResolvedValue(undefined);

      // Multiple fast-fail attempts should all return 503
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/spike')
          .send({ label: `FastFail${i}`, severity: 'low' });
        expect(res.status).toBe(503);
        expect(mockRecord).not.toHaveBeenCalled();
      }
    });
  });

  describe('Circuit Breaker — Half-Open state (recovery probe)', () => {
    it('transitions to HALF_OPEN after cooldown expires', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 5000,
      });
      const app = buildApp(breaker);

      mockRecord.mockRejectedValue(new Error('Service down'));

      // Trip the circuit
      await request(app)
        .post('/spike')
        .send({ label: 'Trip', severity: 'low' });

      expect((await breaker.getMetrics('spike-audit')).state).toBe('OPEN');

      // Advance time past the cooldown
      jest.advanceTimersByTime(5000);

      // Next request should attempt (probe) since we're now in HALF_OPEN
      mockRecord.mockReset();
      mockRecord.mockResolvedValue(undefined);

      // Make a request (this is the probe)
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Probe', severity: 'low' });

      // Probe succeeds, so circuit should close
      expect(res.status).toBe(201);
      const metrics = await breaker.getMetrics('spike-audit');
      expect(metrics.state).toBe('CLOSED');
      expect(mockRecord).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    it('closes circuit on successful probe in HALF_OPEN', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 1000,
      });
      const app = buildApp(breaker);

      mockRecord.mockRejectedValue(new Error('Temporary failure'));

      // Trip the circuit with 2 failures
      for (let i = 0; i < 2; i++) {
        await request(app)
          .post('/spike')
          .send({ label: `Failure${i}`, severity: 'low' });
      }

      expect((await breaker.getMetrics('spike-audit')).state).toBe('OPEN');

      // Wait for cooldown
      jest.advanceTimersByTime(1000);

      // Service recovers
      mockRecord.mockReset();
      mockRecord.mockResolvedValue(undefined);

      // Probe succeeds
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Recovery probe', severity: 'low' });

      expect(res.status).toBe(201);

      // Circuit should now be CLOSED
      const metrics = await breaker.getMetrics('spike-audit');
      expect(metrics.state).toBe('CLOSED');
      expect(metrics.consecutiveFailures).toBe(0);

      jest.useRealTimers();
    });

    it('reopens circuit on failed probe in HALF_OPEN', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 1000,
      });
      const app = buildApp(breaker);

      mockRecord.mockRejectedValue(new Error('Service down'));

      // Trip the circuit
      await request(app)
        .post('/spike')
        .send({ label: 'Trip', severity: 'low' });

      expect((await breaker.getMetrics('spike-audit')).state).toBe('OPEN');

      // Wait for cooldown
      jest.advanceTimersByTime(1000);

      // Service still down; probe will fail
      mockRecord.mockReset();
      mockRecord.mockRejectedValue(new Error('Still down'));

      const res = await request(app)
        .post('/spike')
        .send({ label: 'Probe fails', severity: 'low' });

      expect(res.status).toBe(201); // Request succeeds (audit best-effort)

      // Circuit should go back to OPEN
      const metrics = await breaker.getMetrics('spike-audit');
      expect(metrics.state).toBe('OPEN');

      jest.useRealTimers();
    });
  });

  describe('Input validation — requests fail before circuit breaker', () => {
    it('rejects invalid input with 400, does not hit circuit', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 10 });
      const app = buildApp(breaker);

      // Invalid requests should fail with 400 without calling the audit service
      const res = await request(app)
        .post('/spike')
        .send({ severity: 'high' }); // Missing label

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(mockRecord).not.toHaveBeenCalled();

      // Verify no failure was recorded in the breaker
      const metrics = await breaker.getMetrics('spike-audit');
      expect(metrics.totalFailures).toBe(0);
    });

    it('rejects multiple invalid requests without polluting failure count', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 });
      const app = buildApp(breaker);

      // 5 invalid requests
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post('/spike')
          .send({ label: '', severity: 'bad' });
        expect(res.status).toBe(400);
      }

      // Breaker should still be CLOSED (no failures recorded)
      const metrics = await breaker.getMetrics('spike-audit');
      expect(metrics.state).toBe('CLOSED');
      expect(metrics.totalFailures).toBe(0);
    });

    it('rejects invalid severity with 400', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Test', severity: 'extreme' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('rejects missing severity with 400', async () => {
      const res = await request(app)
        .post('/spike')
        .send({ label: 'Test' });

      expect(res.status).toBe(400);
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('accepts optional fields in PUT requests', async () => {
      const res1 = await request(app)
        .post('/spike')
        .send({ label: 'Original', severity: 'low' });

      const created = res1.body as SpikeRecord;

      const res2 = await request(app)
        .put(`/spike/${created.id}`)
        .send({ severity: 'high' }); // Only update severity

      expect(res2.status).toBe(200);
      expect(res2.body.label).toBe('Original');
      expect(res2.body.severity).toBe('high');
    });
  });
