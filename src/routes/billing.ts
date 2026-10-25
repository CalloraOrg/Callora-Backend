import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { parseCursor } from "../lib/cursorPagination.js";

import {
  BadGatewayError,
  BadRequestError,
  GatewayTimeoutError,
  InternalServerError,
  NotFoundError,
  PaymentRequiredError,
  UnauthorizedError,
} from "../errors/index.js";
import {
  requireAuth,
  type AuthenticatedLocals,
} from "../middleware/requireAuth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { billingDeductHistogramMiddleware } from "../middleware/metricsHistogram.js";
import type { BillingDeductResult } from "../services/billing.js";
import { SorobanRpcError } from "../services/sorobanBilling.js";
import { redactSimulationDetails } from "../lib/simulationDiagnostics.js";
import { billingAccessLogMiddleware } from "../middleware/billingAccessLog.js";
import creditsRouter from "./billing/credits.js";
import deductRouter from "./billing/deduct.js";
import disputesRouter from "./billing/disputes.js";
import refundRouter from "./billing/refund.js";
import { createFeeAbstractionRouter } from "./billing/feeAbstraction.js";
import { createBillingForecastRouter } from "./billing/forecast.js";
import { createBillingPortalRouter } from "./billing/portal.js";
import { etagMiddleware } from "../middleware/etag.js";
import { createTimeoutMiddleware } from "../middleware/timeout.js";
import { config } from "../config/index.js";
import { logger } from "../logger.js";
import { getRequestId, successEnvelope } from "../lib/envelope.js";
import { getBillingService } from "./billing/billingService.js";
import {
  PgUsageEventsRepository,
  type UsageEventsRepositoryQueryable,
} from "../repositories/usageEventsRepository.pg.js";
import type { UsageEventsRepository } from "../repositories/usageEventsRepository.js";

const router = Router();

router.use("/portal", createBillingPortalRouter());

router.use(billingAccessLogMiddleware);
router.use(createTimeoutMiddleware({ timeoutMs: config.billingTimeoutMs }));

router.use("/credits", creditsRouter);
router.use("/disputes", disputesRouter);
router.use("/deduct", deductRouter);
router.use("/refund", refundRouter);
router.use("/fee-abstraction", createFeeAbstractionRouter());
router.use("/forecast", createBillingForecastRouter());

interface BillingDeductBody {
  requestId?: unknown;
  developerId?: unknown;
  apiId?: unknown;
  endpointId?: unknown;
  apiKeyId?: unknown;
  amountUsdc?: unknown;
  idempotencyKey?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${field} is required`);
  }
  return value.trim();
}

function requirePositiveAmount(value: unknown): string {
  const amount = requireString(value, "amountUsdc");
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
    throw new BadRequestError(
      "amountUsdc must be a positive number with at most 7 decimal places",
    );
  }
  return amount;
}

function getPool(req: Request): Pool {
  const pool = req.app?.locals?.dbPool as Pool | undefined;
  if (!pool) {
    throw new InternalServerError("Database pool is not configured");
  }
  return pool;
}

/**
 * Returns the usage-events repository for this request.
 *
 * When tests inject a repository via `req.app.locals.usageEventsRepository`
 * that value is returned directly.  In production the PgUsageEventsRepository
 * is constructed from the db pool that is always present in `app.locals`.
 */
function getUsageEventsRepository(
  req: Request,
): Pick<UsageEventsRepository, "listChargesByConsumer"> {
  const injected = req.app?.locals
    ?.usageEventsRepository as Pick<UsageEventsRepository, "listChargesByConsumer"> | undefined;
  if (injected) {
    return injected;
  }
  const pool = getPool(req);
  return new PgUsageEventsRepository(
    pool as unknown as UsageEventsRepositoryQueryable,
  );
}

function sendSimulationFailure(
  res: Response,
  result: Pick<BillingDeductResult, "error" | "simulationDetails">,
): void {
  console.warn("Soroban simulation diagnostics:", result.simulationDetails);
  res.status(502).json({
    error: "Soroban simulation failed",
    code: "SIMULATION_FAILED",
    simulationDetails: redactSimulationDetails(result.simulationDetails),
  });
}

/**
 * GET /api/billing
 *
 * Returns paginated billing history for the authenticated consumer (caller).
 * Rows are sourced from usage_events — the table that BillingService.runPhase1
 * writes deductions into — and ordered by (created_at DESC, id DESC) so the
 * most recent charges appear first.
 *
 * Index hit: idx_usage_events_user_created (user_id, created_at).
 * Pagination: opaque base64 keyset cursor produced by encodeCursor().
 */
router.get(
  "/",
  requireAuth,
  etagMiddleware,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const limit = Number(req.query.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        next(new BadRequestError("limit must be an integer between 1 and 100"));
        return;
      }

      const cursor = parseCursor(req.query.cursor);
      if (req.query.cursor !== undefined && !cursor) {
        next(new BadRequestError("Invalid cursor"));
        return;
      }

      const repo = getUsageEventsRepository(req);
      const { charges, nextCursor, hasMore } = await repo.listChargesByConsumer({
        userId: user.id,
        limit,
        cursor: cursor ?? undefined,
      });

      const requestId = getRequestId(req);
      logger.info("Billing history retrieved for consumer", {
        correlationId: requestId,
        userId: user.id,
        count: charges.length,
        indexHint: "idx_usage_events_user_created",
      });

      res.status(200).json(
        successEnvelope(
          {
            data: charges.map((charge) => ({
              id: charge.id,
              userId: charge.userId,
              apiId: charge.apiId,
              endpointId: charge.endpointId,
              apiKeyId: charge.apiKeyId,
              requestId: charge.requestId,
              amountUsdc: charge.amountUsdc,
              stellarTxHash: charge.stellarTxHash,
              status: charge.status,
              createdAt: charge.createdAt.toISOString(),
            })),
            meta: {
              limit,
              nextCursor,
              hasMore,
            },
          },
          requestId,
        ),
      );
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/deduct",
  requireAuth,
  idempotencyMiddleware,
  billingDeductHistogramMiddleware,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const body = req.body as BillingDeductBody;
      const requestId = requireString(body.requestId, "requestId");
      const apiId = requireString(body.apiId, "apiId");
      const endpointId = requireString(body.endpointId, "endpointId");
      const apiKeyId = requireString(body.apiKeyId, "apiKeyId");
      const amountUsdc = requirePositiveAmount(body.amountUsdc);
      const idempotencyKey =
        typeof body.idempotencyKey === "string" &&
        body.idempotencyKey.trim() !== ""
          ? body.idempotencyKey.trim()
          : (req.get("Idempotency-Key") ?? undefined);
      const developerId = Object.prototype.hasOwnProperty.call(
        body,
        "developerId",
      )
        ? requireString(body.developerId, "developerId")
        : user.id;

      const billingService = getBillingService(req);
      const result = await billingService.deduct({
        requestId,
        userId: developerId,
        apiId,
        endpointId,
        apiKeyId,
        amountUsdc,
        idempotencyKey,
      });

      if (!result.success) {
        if (result.simulationDetails) {
          sendSimulationFailure(res, result);
          return;
        }

        next(
          new PaymentRequiredError(
            result.error ?? "Billing deduction failed",
            "BILLING_DEDUCTION_FAILED",
          ),
        );
        return;
      }

      res.status(200).json({
        success: true,
        usageEventId: result.usageEventId,
        stellarTxHash: result.stellarTxHash,
        alreadyProcessed: result.alreadyProcessed,
      });
    } catch (error) {
      if (error instanceof SorobanRpcError) {
        if (error.simulationDetails) {
          console.warn(
            "Soroban simulation diagnostics:",
            error.simulationDetails,
          );
          res.status(502).json({
            error: "Soroban simulation failed",
            code: "SIMULATION_FAILED",
            simulationDetails: redactSimulationDetails(error.simulationDetails),
          });
          return;
        }

        switch (error.category) {
          case "INSUFFICIENT_BALANCE":
            next(
              new PaymentRequiredError(error.message, "INSUFFICIENT_BALANCE"),
            );
            return;
          case "TIMEOUT":
            next(new GatewayTimeoutError(error.message, "SOROBAN_RPC_TIMEOUT"));
            return;
          case "CONTRACT_ERROR":
          case "NETWORK_ERROR":
            next(new BadGatewayError(error.message, "SOROBAN_RPC_ERROR"));
            return;
        }
      }
      next(error);
    }
  },
);

router.get(
  "/request/:requestId",
  requireAuth,
  etagMiddleware,
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const requestId = requireString(req.params.requestId, "requestId");
      const billingService = getBillingService(req);
      const result = await billingService.getByRequestId(requestId);

      if (!result) {
        next(
          new NotFoundError(
            "Billing request not found",
            "BILLING_REQUEST_NOT_FOUND",
          ),
        );
        return;
      }

      res.status(200).json({
        success: result.success,
        usageEventId: result.usageEventId,
        stellarTxHash: result.stellarTxHash,
        alreadyProcessed: result.alreadyProcessed,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
