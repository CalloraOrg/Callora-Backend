import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { bodyValidator, validate } from '../middleware/validate.js';
import { buildSuccessEnvelope } from '../middleware/envelope.js';
import { etagMiddleware, generateETag } from '../middleware/etag.js';
import { logger } from '../logger.js';
import { NotFoundError } from '../errors/index.js';
import {
  createTenantSchema,
  tenantParamsSchema,
  updateTenantSchema,
  type CreateTenantInput,
  type UpdateTenantInput,
} from '../validators/tenants.js';

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  contactEmail?: string;
  plan: 'starter' | 'growth' | 'enterprise';
  metadata?: Record<string, string | number | boolean>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantRepository {
  list(actorId: string): Promise<TenantRecord[]>;
  create(input: CreateTenantInput, actorId: string): Promise<TenantRecord>;
  update(tenantId: string, input: UpdateTenantInput, actorId: string): Promise<TenantRecord>;
}

class InMemoryTenantRepository implements TenantRepository {
  private tenants = new Map<string, TenantRecord>();

  async list(actorId: string): Promise<TenantRecord[]> {
    return Array.from(this.tenants.values()).filter((tenant) => tenant.createdBy === actorId);
  }

  async create(input: CreateTenantInput, actorId: string): Promise<TenantRecord> {
    const now = new Date().toISOString();
    const slug = input.slug ?? slugify(input.name);
    const tenant: TenantRecord = {
      id: `ten_${randomUUID()}`,
      name: input.name,
      slug,
      contactEmail: input.contactEmail,
      plan: input.plan,
      metadata: input.metadata,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  async update(tenantId: string, input: UpdateTenantInput, _actorId: string): Promise<TenantRecord> {
    const existing = this.tenants.get(tenantId);
    // Do not create or reveal arbitrary IDs during an update. Both unknown
    // and cross-tenant IDs use the same not-found response to avoid existence
    // probing.
    if (!existing || existing.createdBy !== _actorId) {
      throw new NotFoundError('Tenant not found');
    }

    const updated: TenantRecord = {
      ...existing,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    this.tenants.set(tenantId, updated);
    return updated;
  }
}

export interface TenantsRouterDeps {
  tenantRepository?: TenantRepository;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

  return slug.length >= 3 ? slug : `tenant-${slug || 'new'}`;
}

function requestId(req: Request): string {
  return req.id || 'unknown';
}

function correlationId(req: Request): string {
  return req.header('x-correlation-id') || requestId(req);
}

export function createTenantsRouter(deps: TenantsRouterDeps = {}): Router {
  const router = Router();
  const tenantRepository = deps.tenantRepository ?? new InMemoryTenantRepository();

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
