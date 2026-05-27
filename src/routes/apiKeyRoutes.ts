import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { apiKeyRepository } from '../repositories/apiKeyRepository.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../errors/index.js';

export interface ApiKeyRoutesDeps {
  apiRepository: ApiRepository;
  developerRepository: DeveloperRepository;
}

const apiIdParamsSchema = z.object({
  apiId: z.string().min(1),
});

const keyIdParamsSchema = z.object({
  id: z.string().min(1),
});

const createApiKeyBodySchema = z.object({
  scopes: z.array(z.string().min(1)).max(20).optional().default(['*']),
  rateLimitPerMinute: z.number().int().positive().nullable().optional().default(null),
});

function maskKey(prefix: string): string {
  return `${prefix}****************`;
}

async function assertDeveloperOwnsApi(
  userId: string,
  apiId: string,
  deps: ApiKeyRoutesDeps,
): Promise<void> {
  const developer = await deps.developerRepository.findByUserId(userId);
  if (!developer) {
    throw new NotFoundError('Developer profile not found', 'DEVELOPER_NOT_FOUND');
  }

  const apis = await deps.apiRepository.listByDeveloper(developer.id);
  const ownsApi = apis.some((api) => String(api.id) === apiId);
  if (!ownsApi) {
    throw new ForbiddenError(
      'Forbidden: API does not belong to authenticated developer',
      'API_ACCESS_FORBIDDEN',
    );
  }
}

export function createApiKeyRouter(deps: ApiKeyRoutesDeps): Router {
  const router = Router();

  router.post(
    '/apis/:apiId/keys',
    requireAuth,
    validate({ params: apiIdParamsSchema, body: createApiKeyBodySchema }),
    async (req, res: import('express').Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const { apiId } = apiIdParamsSchema.parse(req.params);
        const { scopes, rateLimitPerMinute } = createApiKeyBodySchema.parse(req.body);

        await assertDeveloperOwnsApi(user.id, apiId, deps);

        const created = apiKeyRepository.create({
          apiId,
          userId: user.id,
          scopes,
          rateLimitPerMinute,
        });

        res.status(201).json({
          id: created.id,
          apiId,
          key: created.key,
          prefix: created.prefix,
          createdAt: created.createdAt.toISOString(),
          revoked: false,
          scopes,
          rateLimitPerMinute,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/apis/:apiId/keys',
    requireAuth,
    validate({ params: apiIdParamsSchema }),
    async (req, res: import('express').Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const { apiId } = apiIdParamsSchema.parse(req.params);
        await assertDeveloperOwnsApi(user.id, apiId, deps);

        const keys = apiKeyRepository.list({ userId: user.id, apiId }).map((record) => ({
          id: record.id,
          apiId: record.apiId,
          prefix: record.prefix,
          maskedKey: maskKey(record.prefix),
          scopes: record.scopes,
          rateLimitPerMinute: record.rateLimitPerMinute,
          createdAt: record.createdAt.toISOString(),
          revoked: record.revoked,
        }));

        res.json({ keys });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    '/keys/:id',
    requireAuth,
    validate({ params: keyIdParamsSchema }),
    (req, res: import('express').Response<unknown, AuthenticatedLocals>, next) => {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const { id } = keyIdParamsSchema.parse(req.params);
      const result = apiKeyRepository.revoke(id, user.id);

      if (result === 'not_found') {
        next(new NotFoundError('API key not found', 'API_KEY_NOT_FOUND'));
        return;
      }

      if (result === 'forbidden') {
        next(new ForbiddenError('Forbidden: API key does not belong to authenticated developer', 'API_KEY_FORBIDDEN'));
        return;
      }

      res.status(204).send();
    },
  );

  return router;
}
