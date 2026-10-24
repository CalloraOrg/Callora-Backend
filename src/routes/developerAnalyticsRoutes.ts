import express from 'express';
import { apiStatusEnum, type ApiStatus } from "../db/schema.js";
import { paginatedResponse, parsePagination } from "../lib/pagination.js";
import {
  requireAuth,
  type AuthenticatedLocals,
} from "../middleware/requireAuth.js";
import {
  type ApiRepository
} from "../repositories/apiRepository.js";
import {
  type DeveloperRepository
} from "../repositories/developerRepository.js";
import {
  type GroupBy,
  type UsageEventsRepository
} from "../repositories/usageEventsRepository.js";
import { buildDeveloperAnalytics } from "../services/developerAnalytics.js";
//import { envelopeValidator } from '../middleware/envelopeValidator.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../errors/index.js";
import {
  getRequestId,
  successEnvelope
} from "../lib/envelope.js";
import { asyncHandler } from "../utils/asyncHandler.js";
//import * as OpenApiValidator from 'express-openapi-validator';

const isValidGroupBy = (value: string): value is GroupBy =>
  value === "day" || value === "week" || value === "month";

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== "string") {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};


export function registerDeveloperAnalyticsRoutes(app: express.Express, developerRepository: DeveloperRepository, apiRepository: ApiRepository, usageEventsRepository: UsageEventsRepository): void {
  app.get(
    "/api/developers/apis",
    requireAuth,
    asyncHandler(async (req, res: express.Response<unknown, AuthenticatedLocals>, next) => {
      const requestId = getRequestId(req);
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const developer = await developerRepository.findByUserId(user.id);
      if (!developer) {
        next(new NotFoundError("Developer profile not found"));
        return;
      }

      const statusParam =
        typeof req.query.status === "string" ? req.query.status : undefined;
      let statusFilter: ApiStatus | undefined;
      if (statusParam) {
        if (!apiStatusEnum.includes(statusParam as ApiStatus)) {
          next(
            new BadRequestError(
              `status must be one of: ${apiStatusEnum.join(", ")}`,
            ),
          );
          return;
        }
        statusFilter = statusParam as ApiStatus;
      }

      const { limit, offset } = parsePagination(
        req.query as Record<string, string>,
      );

      const apis = await apiRepository.listByDeveloper(developer.id, {
        status: statusFilter,
        limit,
        offset,
      });

      const usageStats = await usageEventsRepository.aggregateByDeveloper(
        user.id,
      );
      const statsByApi = new Map(usageStats.map((stat) => [stat.apiId, stat]));

      const payload = apis.map((api) => {
        const stats = statsByApi.get(String(api.id));
        const entry: {
          id: number;
          name: string;
          status: ApiStatus;
          callCount: number;
          revenue?: string;
        } = {
          id: api.id,
          name: api.name,
          status: api.status,
          callCount: stats?.calls ?? 0,
        };
        if (stats) {
          entry.revenue = stats.revenue.toString();
        }
        return entry;
      });

      res.json(
        successEnvelope(
          paginatedResponse(payload, { limit, offset }),
          requestId,
        ),
      );
    }),
  );

  app.get(
    "/api/developers/analytics",
    requireAuth,
    asyncHandler(async (req, res: express.Response<unknown, AuthenticatedLocals>, next) => {
      const requestId = getRequestId(req);
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const groupBy = req.query.groupBy ?? "day";
      if (typeof groupBy !== "string" || !isValidGroupBy(groupBy)) {
        next(new BadRequestError("groupBy must be one of: day, week, month"));
        return;
      }

      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      if (!from || !to) {
        next(new BadRequestError("from and to are required ISO date values"));
        return;
      }
      if (from > to) {
        next(new BadRequestError("from must be before or equal to to"));
        return;
      }

      const apiId =
        typeof req.query.apiId === "string" ? req.query.apiId : undefined;
      if (apiId) {
        const ownsApi = await usageEventsRepository.developerOwnsApi(
          user.id,
          apiId,
        );
        if (!ownsApi) {
          next(
            new ForbiddenError(
              "Forbidden: API does not belong to authenticated developer",
            ),
          );
          return;
        }
      }

      const includeTop = req.query.includeTop === "true";
      const events = await usageEventsRepository.findByDeveloper({
        developerId: user.id,
        from,
        to,
        apiId,
      });

      const analytics = buildDeveloperAnalytics(events, groupBy, includeTop);
      res.json(successEnvelope(analytics, requestId));
    }),
  );

}
