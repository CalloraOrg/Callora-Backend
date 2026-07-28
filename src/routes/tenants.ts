import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { bodyValidator, validate } from '../middleware/validate.js';
import { buildSuccessEnvelope } from '../middleware/envelope.js';
import { logger } from '../logger.js';
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
  create(input: CreateTenantInput, actorId: string): Promise<TenantRecord>;
  update(tenantId: string, input: UpdateTenantInput, actorId: string): Promise<TenantRecord>;
}

class InMemoryTenantRepository implements TenantRepository {
  private tenants = new Map<string, TenantRecord>();

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
    const existing = this.tenants.get(tenantId) ?? {
      id: tenantId,
      name: 'Existing tenant',
      slug: slugify(tenantId),
      plan: 'starter' as const,
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

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

  return router;
}

export default createTenantsRouter();
