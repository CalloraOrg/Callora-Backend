import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { idempotencyMiddleware, type IdempotencyConfig } from '../../middleware/idempotency.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../errors/index.js';
import type { ScheduledExportsService } from '../../services/scheduledExports.js';
import { exportsAccessLogMiddleware } from '../../middleware/exportsAccessLog.js';

const EXPORT_IDEMPOTENCY_CONFIG: IdempotencyConfig = {
  keyFromHeader: 'idempotency-key',
  keyFromBody: 'idempotencyKey',
  bodyExcludingKeys: ['idempotencyKey'],
  retentionSeconds: 3600,
  cleanExpiredTTL: true,
  conflictErrorCode: 'IDEMPOTENCY_KEY_REUSE_MISMATCH',
  inProgressErrorCode: 'IDEMPOTENCY_IN_PROGRESS',
};

const scheduleBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  cron: z.string().trim().min(1).max(100),
  s3Bucket: z.string().trim().min(1).max(255),
  s3Region: z.string().trim().min(1).max(120),
  s3Endpoint: z.string().trim().url(),
  s3AccessKeyId: z.string().trim().min(1).max(255),
  s3SecretAccessKey: z.string().trim().min(1).max(255),
  s3PathPrefix: z.string().trim().max(255).optional(),
  enabled: z.boolean().optional(),
});

const schedulePatchSchema = scheduleBodySchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided',
});

export function createExportSchedulesRouter(service: ScheduledExportsService): Router {
  const router = Router();

  const idempotencyHandler = (req: Parameters<typeof idempotencyMiddleware>[0], res: Parameters<typeof idempotencyMiddleware>[1], next: Parameters<typeof idempotencyMiddleware>[2]) =>
    idempotencyMiddleware(req, res, next, EXPORT_IDEMPOTENCY_CONFIG);

  router.get('/', requireAuth, async (_req, res, next) => {
    try {
      const user = (res as typeof res & { locals: AuthenticatedLocals }).locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();
      const schedules = await service.listSchedulesForDeveloper(user.id);
      res.json({ data: schedules });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', requireAuth, idempotencyHandler, validate({ body: scheduleBodySchema }), async (req, res, next) => {
    try {
      const user = (res as typeof res & { locals: AuthenticatedLocals }).locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();
      const schedule = await service.createSchedule({ developerId: user.id, ...scheduleBodySchema.parse(req.body) });
      res.status(201).json({ data: { ...schedule, s3SecretAccessKey: '[REDACTED]' } });
    } catch (error) {
      if (error instanceof Error && error.message.includes('cron')) {
        next(new BadRequestError(error.message, 'INVALID_EXPORT_SCHEDULE'));
        return;
      }
      next(error);
    }
  });

  router.patch('/:scheduleId', requireAuth, idempotencyHandler, validate({ body: schedulePatchSchema }), async (req, res, next) => {
    try {
      const user = (res as typeof res & { locals: AuthenticatedLocals }).locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();
      const updated = await service.updateSchedule(req.params.scheduleId, user.id, schedulePatchSchema.parse(req.body));
      if (!updated) throw new NotFoundError('Export schedule not found', 'EXPORT_SCHEDULE_NOT_FOUND');
      res.json({ data: updated });
    } catch (error) {
      if (error instanceof Error && error.message.includes('cron')) {
        next(new BadRequestError(error.message, 'INVALID_EXPORT_SCHEDULE'));
        return;
      }
      next(error);
    }
  });

  return router;
}
