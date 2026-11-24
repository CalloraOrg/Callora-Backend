import { Router, type Request, type Response } from 'express';
import { config } from '../config/index.js';
import { pool } from '../db.js';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { bodyValidator, validate } from '../middleware/validate.js';
import { buildSuccessEnvelope } from '../middleware/envelope.js';
import { etagMiddleware, generateETag } from '../middleware/etag.js';
import { logger } from '../logger.js';
import {
  InMemoryTenantRepository,
  PostgresTenantRepository,
  type TenantRecord,
  type TenantRepository,
  type TenantRepositoryQueryable,
} from '../repositories/tenantRepository.js';
import {
  createTenantSchema,
  tenantParamsSchema,
  updateTenantSchema,
} from '../validators/tenants.js';

export type { TenantRecord, TenantRepository };

export interface TenantsRouterDeps {
  tenantRepository?: TenantRepository;
  pool?: TenantRepositoryQueryable;
}

function requestId(req: Request): string {
  return req.id || 'unknown';
}

function correlationId(req: Request): string {
  return req.header('x-correlation-id') || requestId(req);
}

export function createTenantsRouter(deps: TenantsRouterDeps = {}): Router {
  const router = Router();
  const tenantRepository =
    deps.tenantRepository ??
    (deps.pool
      ? new PostgresTenantRepository(deps.pool)
      : !config.demoMode && Boolean(process.env.DATABASE_URL)
        ? new PostgresTenantRepository(pool)
        : new InMemoryTenantRepository());

  router.post(
    '/',
    requireAuth,
    bodyValidator(createTenantSchema),
    async (req: Request, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actorId = res.locals.authenticatedUser!.id;
        const body = createTenantSchema.parse(req.body);
        const tenant = await tenantRepository.create(body, actorId);

        logger.info('[tenants] tenant created', {
          requestId: requestId(req),
          correlationId: correlationId(req),
          tenantId: tenant.id,
          actorId,
          slug: tenant.slug,
        });

        res.status(201).json(buildSuccessEnvelope(tenant, requestId(req)));
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/:tenantId',
    requireAuth,
    validate({ params: tenantParamsSchema, body: updateTenantSchema }),
    async (req: Request, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actorId = res.locals.authenticatedUser!.id;
        const { tenantId } = tenantParamsSchema.parse(req.params);
        const body = updateTenantSchema.parse(req.body);
        const tenant = await tenantRepository.update(tenantId, body, actorId);

        logger.info('[tenants] tenant updated', {
          requestId: requestId(req),
          correlationId: correlationId(req),
          tenantId,
          actorId,
        });

        res.json(buildSuccessEnvelope(tenant, requestId(req)));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/',
    requireAuth,
    etagMiddleware,
    async (req: Request, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actorId = res.locals.authenticatedUser!.id;
        const tenants = await tenantRepository.list(actorId);

        logger.info('[tenants] tenants listed', {
          requestId: requestId(req),
          correlationId: correlationId(req),
          count: tenants.length,
        });

        // Pre-set a strong ETag derived from the tenant data alone, so that the
        // ETag is stable across calls that return the same tenant list regardless
        // of envelope fields that change per-request (timestamp, requestId).
        // The etagMiddleware will honour the pre-set ETag and evaluate
        // If-None-Match against it without recomputing a new hash.
        res.setHeader('ETag', generateETag(JSON.stringify(tenants)));

        res.json(buildSuccessEnvelope(tenants, requestId(req)));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createTenantsRouter();
