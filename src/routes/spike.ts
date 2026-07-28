import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { createTimeoutMiddleware } from '../middleware/timeout.js';
import { defaultAuditService, type AuditService } from '../services/auditService.js';
import { logger } from '../logger.js';
import { NotFoundError, BadRequestError, ServiceUnavailableError } from '../errors/index.js';
import { CircuitBreaker, CircuitBreakerOpenError } from '../lib/circuitBreaker.js';

export interface SpikeRecord {
  id: string;
  label: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  updatedAt: string;
}

export interface SpikeRouterDeps {
  auditService?: AuditService;
  circuitBreaker?: CircuitBreaker;
}

const spikeStore: SpikeRecord[] = [];
let nextId = 1;

/**
 * Zod schemas for spike route validation.
 * These ensure that invalid requests fail with 400 BEFORE reaching the circuit breaker,
 * so breaker failure counts only reflect actual downstream failures, not client errors.
 */
const SpikeCreateSchema = z.object({
  label: z.string().min(1, 'label is required and must be a non-empty string'),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
});

const SpikeUpdateSchema = z.object({
  label: z.string().min(1, 'label must be a non-empty string').optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
});

type SpikeCreateInput = z.infer<typeof SpikeCreateSchema>;
type SpikeUpdateInput = z.infer<typeof SpikeUpdateSchema>;

export function createSpikeRouter(deps: SpikeRouterDeps = {}): Router {
  const router = Router();
  const auditService = deps.auditService ?? defaultAuditService;

  /**
   * Circuit breaker configured for audit service calls.
   * Defaults: 5 consecutive failures to trip, 30s cooldown, 1 success to recover.
   * A separate breaker instance per router allows independent scaling/tuning if needed.
   */
  const auditBreaker =
    deps.circuitBreaker ??
    new CircuitBreaker({
      failureThreshold: 5,
      cooldownMs: 30000,
      successThreshold: 1,
    });

  /**
   * Records an audit log through the circuit breaker.
   * If the circuit is open, throws ServiceUnavailableError (503) instead of attempting
   * the downstream call, ensuring fast failure without cascading delays.
   *
   * Failures to the audit service (network timeouts, server errors) increment the
   * breaker's failure counter. Once failures exceed the threshold, the circuit opens
   * and subsequent calls fail immediately. After a cooldown, the circuit enters
   * half-open state and allows a trial call to test recovery.
   *
   * Invalid requests (bad input validation) fail with 400 BEFORE this call, so they
   * do not count as audit service failures.
   */
  async function recordAuditWithBreaker(
    req: Request,
    event: string,
    actor: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const ctx = req.auditContext;
    const correlationId = (req as Request & { correlationId?: string }).correlationId ?? 'unknown';

    try {
      await auditBreaker.execute('spike-audit', async () => {
        await auditService.record({
          event,
          actor,
          tenantId: ctx?.tenantId ?? null,
          clientIp: ctx?.clientIp ?? null,
          userAgent: ctx?.userAgent ?? null,
          correlationId: ctx?.correlationId ?? null,
          bodyHash: ctx?.bodyHash ?? null,
          details,
        });
      });
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        // Circuit is open: log the fast-fail and convert to 503
        logger.error(
          { event, actor, correlationId, err: error },
          'Audit circuit breaker is open; failing fast with 503',
        );
        throw new ServiceUnavailableError(
          'Audit service temporarily unavailable',
          'SERVICE_UNAVAILABLE',
        );
      }

      // Other errors (network, server-side) still log and should not propagate
      // since audit is best-effort. The route succeeds but we've recorded the failure
      // in the breaker for future fast-fail decisions.
      logger.error(
        { event, actor, correlationId, err: error },
        'Failed to persist audit log for spike mutation',
      );
    }
  }

  router.get('/', createTimeoutMiddleware({ timeoutMs: 1000 }), async (req, res, next) => {
    try {
      let delay = 2000;
      if (typeof req.query.delay === 'string') {
        const parsed = parseInt(req.query.delay, 10);
        if (!isNaN(parsed) && parsed > 0) {
          delay = parsed;
        }
      }

      const sleepInterval = 50;
      let elapsed = 0;

      while (elapsed < delay) {
        if (req.signal?.aborted) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, sleepInterval));
        elapsed += sleepInterval;
      }

      res.json({
        success: true,
        message: 'Spike completed successfully',
        delay,
        elapsed,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/records', (_req, res) => {
    res.json({ records: spikeStore });
  });

  router.post('/', async (req, res, next) => {
    try {
      // Validate input FIRST, before touching the breaker.
      // Invalid requests fail with 400 and do NOT count as downstream failures.
      const parseResult = SpikeCreateSchema.safeParse(req.body ?? {});
      if (!parseResult.success) {
        next(
          new BadRequestError(
            parseResult.error.issues.map((i) => i.message).join('; '),
          ),
        );
        return;
      }

      const { label, severity } = parseResult.data;

      const id = String(nextId++);
      const now = new Date().toISOString();
      const record: SpikeRecord = {
        id,
        label: label.trim(),
        severity,
        createdAt: now,
        updatedAt: now,
      };

      spikeStore.push(record);

      const actor = req.developerId ?? 'anonymous';

      // Record audit through the circuit breaker.
      // If the breaker is open, this throws ServiceUnavailableError (503).
      await recordAuditWithBreaker(req, 'SPIKE_CREATE', actor, {
        spikeId: id,
        before: null,
        after: { label: record.label, severity: record.severity },
      });

      res.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const index = spikeStore.findIndex((r) => r.id === id);

      if (index === -1) {
        next(new NotFoundError(`Spike record ${id} not found`));
        return;
      }

      // Validate input FIRST, before touching the breaker.
      const parseResult = SpikeUpdateSchema.safeParse(req.body ?? {});
      if (!parseResult.success) {
        next(
          new BadRequestError(
            parseResult.error.issues.map((i) => i.message).join('; '),
          ),
        );
        return;
      }

      const existing = spikeStore[index]!;
      const { label, severity } = parseResult.data;

      const updated: SpikeRecord = {
        ...existing,
        label: label !== undefined ? label.trim() : existing.label,
        severity: severity !== undefined ? severity : existing.severity,
        updatedAt: new Date().toISOString(),
      };

      spikeStore[index] = updated;

      const actor = req.developerId ?? 'anonymous';

      // Record audit through the circuit breaker.
      await recordAuditWithBreaker(req, 'SPIKE_UPDATE', actor, {
        spikeId: id,
        before: { label: existing.label, severity: existing.severity },
        after: { label: updated.label, severity: updated.severity },
      });

      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const index = spikeStore.findIndex((r) => r.id === id);

      if (index === -1) {
        next(new NotFoundError(`Spike record ${id} not found`));
        return;
      }

      const removed = spikeStore.splice(index, 1)[0]!;

      const actor = req.developerId ?? 'anonymous';

      // Record audit through the circuit breaker.
      await recordAuditWithBreaker(req, 'SPIKE_DELETE', actor, {
        spikeId: id,
        before: { label: removed.label, severity: removed.severity },
        after: null,
      });

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
