import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import {
  developerCategoryEnum,
  DeveloperRevenueResponse,
  SettlementStore,
} from '../types/developer.js';
import { UsageStore, ApiRegistry } from '../types/gateway.js';
import { addDecimalStrings, InMemoryUsageStore } from '../services/usageStore.js';
import { ForbiddenError, UnauthorizedError } from '../errors/index.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import type { UsageEventsRepository } from '../repositories/usageEventsRepository.js';
import { InMemoryUsageEventsRepository } from '../repositories/usageEventsRepository.js';
import type { ReportExporterService } from '../services/reportExporter.js';
import { createDeveloperMeUsageRouter } from './developers/me/usage.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export interface DeveloperRoutesDeps {
  settlementStore: SettlementStore;
  usageStore: UsageStore;
  developerRepository: DeveloperRepository;
  apiRegistry?: ApiRegistry;
  usageEventsRepository?: UsageEventsRepository;
  reportExporterService?: ReportExporterService;
}

export function createDeveloperRouter(deps: DeveloperRoutesDeps): Router {
  const router = Router();
  const { settlementStore, usageStore, developerRepository, apiRegistry, reportExporterService } = deps;
  const usageEventsRepository = deps.usageEventsRepository ?? new InMemoryUsageEventsRepository();

  if (apiRegistry && usageStore instanceof InMemoryUsageStore) {
    usageStore.setApiRegistry(apiRegistry);
  }

  router.use(
    '/me/usage',
    createDeveloperMeUsageRouter({
      usageEventsRepository,
      developerRepository,
    }),
  );

  // Validation schema for revenue query parameters
  const revenueQuerySchema = z.object({
    limit: z
      .string()
      .optional()
      .transform((val) => val ? parseInt(val, 10) : 20)
      .pipe(z.number().int())
      .transform((val) => Math.min(Math.max(val, 1), 100)),
    offset: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : 0))
      .pipe(z.number().int().min(0)),
    page: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : undefined))
      .pipe(z.number().int().min(1).optional()),
  });

  const developerProfilePatchSchema = z
    .object({
      name: z.string().trim().min(1).max(120).nullable().optional(),
      website: z.string().trim().url().nullable().optional(),
      description: z.string().trim().max(500).nullable().optional(),
      category: z.enum(developerCategoryEnum).nullable().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'At least one profile field must be provided',
      path: [],
    });

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) {
        throw new UnauthorizedError();
      }

      const profile = await developerRepository.getOrCreateByUserId(user.id);
      res.json(profile);
    }),
  );

  router.patch(
    '/me',
    requireAuth,
    validate({ body: developerProfilePatchSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) {
        throw new UnauthorizedError();
      }

      const body = developerProfilePatchSchema.parse(req.body);
      const profile = await developerRepository.upsertProfile(user.id, body);
      res.json(profile);
    }),
  );

  /**
   * GET /api/developers/revenue
   *
   * Returns the authenticated developer's revenue summary and
   * a paginated list of settlements.
   *
   * Query params:
   *   limit  – number of settlements to return (default 20, max 100)
   *   offset – pagination offset (default 0)
   *
   * @schema DeveloperRevenueResponse
   * @example
   * {
   *   "summary": {
   *     "total_earned": 500,
   *     "pending": 100,
   *     "available_to_withdraw": 400
   *   },
   *   "settlements": [
   *     {
   *       "id": "123e4567-e89b-12d3-a456-426614174000",
   *       "developerId": "dev-1",
   *       "amount": 100,
   *       "status": "completed",
   *       "tx_hash": "a1b2c3d4...",
   *       "created_at": "2026-02-01T10:00:00.000Z"
   *     }
   *   ],
   *   "pagination": {
   *     "limit": 20,
   *     "offset": 0,
   *     "total": 1
   *   }
   * }
   */
  router.get(
    '/revenue',
    requireAuth,
    validate({ query: revenueQuerySchema }),
    asyncHandler(async (req, res) => {
      // requireAuth guarantees this is set; guard is a type-safety belt
      const user = res.locals.authenticatedUser;
      if (!user) {
        throw new UnauthorizedError();
      }

      // Resolve the developer profile from the authenticated user.
      // This is the single source of truth for ownership — the developer
      // record must exist and must belong to the authenticated user.
      const developer = await developerRepository.findByUserId(user.id);
      if (!developer) {
        // The authenticated user has no developer profile → they own nothing.
        // Return 403 (not 404) to avoid leaking whether a resource exists.
        throw new ForbiddenError(
          'No developer profile found for this account',
          'DEVELOPER_NOT_FOUND',
        );
      }

      // Ownership is enforced: developer.user_id === user.id (guaranteed by
      // findByUserId). All data queries below are scoped to this developer's
      // user_id, preventing any cross-tenant data access.
      const developerId = developer.user_id;

      const parsedQuery = revenueQuerySchema.parse(req.query);
      const limit = parsedQuery.limit;
      let offset = parsedQuery.offset;

      if (parsedQuery.page) {
        offset = (parsedQuery.page - 1) * limit;
      }

      // Fetch a single page of settlements and database-computed totals for the verified developer
      let settlements;
      let total: number;
      let completedTotalStr: string;
      let pendingTotalStr: string;

      if (typeof settlementStore.getDeveloperSettlementsPage === 'function') {
        const page = await settlementStore.getDeveloperSettlementsPage(developerId, {
          limit,
          offset,
        });
        settlements = page.settlements;
        total = page.total;
        completedTotalStr = page.completedTotal;
        pendingTotalStr = page.pendingTotal;
      } else {
        const allSettlements = await settlementStore.getDeveloperSettlements(developerId);
        settlements = allSettlements.slice(offset, offset + limit);
        total = allSettlements.length;
        completedTotalStr = addDecimalStrings(
          ...allSettlements
            .filter((s) => s.status === 'completed' && s.amount > 0)
            .map((s) => s.amount),
        );
        pendingTotalStr = addDecimalStrings(
          ...allSettlements
            .filter((s) => s.status === 'pending' && s.amount > 0)
            .map((s) => s.amount),
        );
      }

      // Unsettled usage revenue attributed to the API owner (not the consuming caller)
      let unsettledRevenueStr: string;
      if (typeof usageStore.getUnsettledRevenueForDeveloper === 'function') {
        unsettledRevenueStr = await usageStore.getUnsettledRevenueForDeveloper(developerId);
      } else {
        const rawUnsettled = await usageStore.getUnsettledEvents(developerId);
        const ownerUnsettled = rawUnsettled.filter((e) => {
          if (!(e.amountUsdc > 0)) return false;
          const ownerId =
            (e.apiId ? apiRegistry?.resolve(e.apiId)?.developerId : undefined) ??
            e.developerId ??
            e.userId;
          return ownerId === developerId;
        });
        unsettledRevenueStr = addDecimalStrings(...ownerUnsettled.map((e) => e.amountUsdc));
      }

      const totalEarnedStr = addDecimalStrings(
        completedTotalStr,
        unsettledRevenueStr,
        pendingTotalStr,
      );

      const body: DeveloperRevenueResponse = {
        summary: {
          total_earned: Number(totalEarnedStr),
          pending: Number(pendingTotalStr),
          available_to_withdraw: Number(unsettledRevenueStr),
        },
        settlements,
        pagination: { limit, offset, total },
      };

      res.json(body);
    }),
  );

  // Validation schema for exports query parameters
  const exportsQuerySchema = z.object({
    limit: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : 20))
      .pipe(z.number().int())
      .transform((val) => Math.min(Math.max(val, 1), 100)),
    offset: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : 0))
      .pipe(z.number().int().min(0)),
  });

  if (reportExporterService) {
    router.get(
      '/exports',
      requireAuth,
      validate({ query: exportsQuerySchema }),
      asyncHandler(async (req, res) => {
        const user = res.locals.authenticatedUser;
        if (!user) throw new UnauthorizedError();
        const developer = await developerRepository.findByUserId(user.id);
        if (!developer)
          throw new ForbiddenError('No developer profile found for this account', 'DEVELOPER_NOT_FOUND');

        const parsedQuery = exportsQuerySchema.parse(req.query);
        const { limit, offset } = parsedQuery;
        const ttl = Number(process.env.EXPORT_SIGNED_URL_TTL_SECONDS ?? '900');

        const records = await reportExporterService.listExportsForDeveloper(developer.user_id, { limit, offset });
        const data = records.map((r) => ({
          id: r.id,
          format: r.format,
          exportedAt: r.exportedAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          downloadUrl: reportExporterService.getSignedUrl(r, ttl),
        }));

        res.json({ data, pagination: { limit, offset, total: data.length } });
      }),
    );
  }

  return router;
}
